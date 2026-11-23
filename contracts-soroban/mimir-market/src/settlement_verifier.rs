//! Offline settlement conservation verifier.
//!
//! Checks a canonical synthetic settlement manifest against the payout rules in
//! `resolve.rs` and `fees.rs`, with no chain access, no `Env`, no storage and no
//! allocation. It reports the first leg whose principal, fee or remainder
//! disagrees with what the contract would have computed.
//!
//! The contract stays authoritative. This verifier re-derives the expected
//! amounts from the same integer rules so a reviewer, indexer or CI job can
//! check a recorded settlement without RPC:
//!
//! * fees are charged on profit only (`gross - principal`, floored at zero);
//!   each leg is `floor(profit * bps / BPS_DIVISOR)`, and a leg with no
//!   recipient is not charged (`fees::quote_fees`);
//! * pool mode pays `stake + floor(stake * creator_stake / total_challenger_stake)`,
//!   fixed odds pays `floor(stake * payout_bps / BPS_DIVISOR)`, and a draw or an
//!   unresolvable verdict returns principal (`resolve::gross_for`);
//! * the final challenger to claim takes the escrow that is left, so truncation
//!   dust is distributed rather than stranded (`resolve::gross_for`);
//! * `paid + fees + remaining == inflow`, so nothing is created or lost.
//!
//! # Manifest format (version 1)
//!
//! Plain UTF-8 text, one record per line. Blank lines and lines starting with
//! `#` are ignored. Amounts are atomic USDC integers (7 decimals). The first
//! record must be the header; challenger lines are listed in claim order.
//!
//! ```text
//! mimir-settlement-manifest v1
//! claim 42
//! winner challengers            # creator | challengers | draw | unresolvable
//! mode pool                     # pool | fixed
//! payout_bps 20000              # fixed odds only
//! creator_stake 100000000
//! platform_fee_bps 200
//! agent_owner_fee_bps 100
//! platform_recipient yes        # yes | no
//! agent_owner_recipient no      # yes | no
//! creator_paid 0                # what the creator received at resolution
//! creator_fee 0                 # fees taken from the creator leg
//! challenger 30000000 60000000 600000 59400000   # stake gross fee net, claim order
//! challenger 70000000 140000000 1400000 138600000
//! remaining 0                   # escrow still owed after the listed claims
//! ```
//!
//! Every challenger on the roster appears once. A challenger that has not
//! claimed yet is written `challenger <stake> - - -`; claimed legs must come
//! before unclaimed ones.

use crate::types::BPS_DIVISOR;

/// Header line every version-1 manifest starts with.
pub const MANIFEST_HEADER_V1: &str = "mimir-settlement-manifest v1";

/// Settled outcome recorded in a manifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Creator,
    Challengers,
    Draw,
    Unresolvable,
}

/// Odds mode recorded in a manifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Pool,
    Fixed,
}

/// Which amount of a leg disagreed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    /// Gross paid to the leg before fees (principal plus any winnings).
    Principal,
    /// Fee taken from the leg.
    Fee,
    /// Net received by the participant (`gross - fee`).
    Net,
}

/// The settlement leg a mismatch was found on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leg {
    Creator,
    /// Zero-based position in claim order.
    Challenger(u32),
}

/// Why a manifest failed verification. The first failure wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mismatch {
    /// The manifest could not be read. `line` is 1-based.
    Malformed { line: u32 },
    /// The first record is not [`MANIFEST_HEADER_V1`].
    UnsupportedVersion,
    /// A required record is missing.
    Missing { record: &'static str },
    /// A leg's principal, fee or net differs from the contract's rule.
    Leg {
        leg: Leg,
        field: Field,
        expected: i128,
        found: i128,
    },
    /// The escrow left over after the listed claims is wrong. When every
    /// challenger has claimed, `expected` is always zero: no dust may remain.
    Remainder { expected: i128, found: i128 },
    /// Paid, fees and remaining together do not equal the inflow.
    Conservation { inflow: i128, accounted: i128 },
    /// An amount, sum or product does not fit in `i128`.
    Overflow,
}

/// Totals of a manifest that verified.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Report {
    pub claim_id: u64,
    pub inflow: i128,
    pub paid: i128,
    pub fees: i128,
    pub remaining: i128,
    pub challengers: u32,
    pub claimed: u32,
}

#[derive(Clone, Copy)]
struct Header {
    claim_id: u64,
    outcome: Outcome,
    mode: Mode,
    payout_bps: Option<u32>,
    creator_stake: i128,
    platform_bps: u32,
    owner_bps: u32,
    platform_recipient: bool,
    owner_recipient: bool,
    creator_paid: i128,
    creator_fee: i128,
    remaining: i128,
}

#[derive(Clone, Copy)]
struct ChallengerLine {
    stake: i128,
    /// `(gross, fee, net)`, or `None` when the challenger has not claimed.
    paid: Option<(i128, i128, i128)>,
}

/// Verify a settlement manifest. Returns the totals when every leg conserves.
pub fn verify_manifest(text: &str) -> Result<Report, Mismatch> {
    let header = read_header(text)?;

    // Pass 1: roster totals, and the claim-order rule.
    let mut total_stake = 0i128;
    let mut count = 0u32;
    let mut claimed = 0u32;
    let mut seen_unclaimed = false;
    for (line_no, line) in records(text) {
        if let Some(c) = parse_challenger(line, line_no)? {
            if c.stake <= 0 {
                return Err(Mismatch::Malformed { line: line_no });
            }
            match c.paid {
                Some(_) if seen_unclaimed => return Err(Mismatch::Malformed { line: line_no }),
                Some(_) => claimed += 1,
                None => seen_unclaimed = true,
            }
            total_stake = add(total_stake, c.stake)?;
            count = count.checked_add(1).ok_or(Mismatch::Overflow)?;
        }
    }

    let inflow = add(header.creator_stake, total_stake)?;

    // Creator leg, settled inline at resolution.
    let (exp_creator_gross, exp_owed_to_challengers) = creator_leg(&header, total_stake, text)?;
    let exp_creator_fee = match header.outcome {
        Outcome::Creator => fee_for(&header, header.creator_stake, exp_creator_gross)?,
        _ => 0,
    };
    let exp_creator_net = exp_creator_gross - exp_creator_fee;
    check(
        Leg::Creator,
        Field::Fee,
        exp_creator_fee,
        header.creator_fee,
    )?;
    check(
        Leg::Creator,
        Field::Net,
        exp_creator_net,
        header.creator_paid,
    )?;

    // Pass 2: each challenger pull, drawing the escrow down in claim order.
    let mut remaining = exp_owed_to_challengers;
    let mut paid = header.creator_paid;
    let mut fees = header.creator_fee;
    let mut index = 0u32;
    for (line_no, line) in records(text) {
        let c = match parse_challenger(line, line_no)? {
            Some(c) => c,
            None => continue,
        };
        if let Some((gross, fee, net)) = c.paid {
            let leg = Leg::Challenger(index);
            let is_last = index + 1 == count;
            let exp_gross = match header.outcome {
                Outcome::Creator => 0,
                _ if is_last => remaining,
                Outcome::Challengers => match header.mode {
                    Mode::Fixed => bps_of(c.stake, header.payout_bps.unwrap_or(0))?,
                    Mode::Pool => add(
                        c.stake,
                        pool_share(c.stake, header.creator_stake, total_stake)?,
                    )?,
                },
                Outcome::Draw | Outcome::Unresolvable => c.stake,
            };
            check(leg, Field::Principal, exp_gross, gross)?;
            if gross > remaining {
                return Err(Mismatch::Remainder {
                    expected: remaining,
                    found: gross,
                });
            }
            let exp_fee = fee_for(&header, c.stake, gross)?;
            check(leg, Field::Fee, exp_fee, fee)?;
            check(leg, Field::Net, gross - fee, net)?;
            remaining -= gross;
            paid = add(paid, net)?;
            fees = add(fees, fee)?;
        }
        index += 1;
    }

    // What is left is still owed to the challengers who have not claimed. A
    // creator win leaves nothing, and once every challenger has claimed the
    // last one has absorbed the truncation dust, so nothing may remain.
    if header.remaining != remaining {
        return Err(Mismatch::Remainder {
            expected: remaining,
            found: header.remaining,
        });
    }

    let accounted = add(add(paid, fees)?, header.remaining)?;
    if accounted != inflow {
        return Err(Mismatch::Conservation { inflow, accounted });
    }

    Ok(Report {
        claim_id: header.claim_id,
        inflow,
        paid,
        fees,
        remaining: header.remaining,
        challengers: count,
        claimed,
    })
}

/// Expected `(creator_gross, owed_to_challengers)` at resolution, mirroring
/// `resolve::resolve_claim_versioned`.
fn creator_leg(header: &Header, total_stake: i128, text: &str) -> Result<(i128, i128), Mismatch> {
    let inflow = add(header.creator_stake, total_stake)?;
    match header.outcome {
        Outcome::Creator => Ok((inflow, 0)),
        Outcome::Draw | Outcome::Unresolvable => Ok((header.creator_stake, total_stake)),
        Outcome::Challengers => match header.mode {
            Mode::Pool => Ok((0, inflow)),
            Mode::Fixed => {
                let bps = header.payout_bps.ok_or(Mismatch::Missing {
                    record: "payout_bps",
                })?;
                // reserved_creator_liability is the sum of every challenger's
                // fixed-odds profit, accumulated at challenge time.
                let mut reserved = 0i128;
                for (line_no, line) in records(text) {
                    if let Some(c) = parse_challenger(line, line_no)? {
                        let gross = bps_of(c.stake, bps)?;
                        reserved = add(reserved, (gross - c.stake).max(0))?;
                    }
                }
                if reserved > header.creator_stake {
                    return Err(Mismatch::Conservation {
                        inflow,
                        accounted: add(total_stake, reserved)?,
                    });
                }
                Ok((header.creator_stake - reserved, add(total_stake, reserved)?))
            }
        },
    }
}

fn fee_for(header: &Header, principal: i128, gross: i128) -> Result<i128, Mismatch> {
    if gross <= principal {
        return Ok(0);
    }
    let profit = gross - principal;
    let platform = if header.platform_recipient {
        bps_of(profit, header.platform_bps)?
    } else {
        0
    };
    let owner = if header.owner_recipient {
        bps_of(profit, header.owner_bps)?
    } else {
        0
    };
    add(platform, owner)
}

fn bps_of(amount: i128, bps: u32) -> Result<i128, Mismatch> {
    amount
        .checked_mul(bps as i128)
        .map(|p| p / BPS_DIVISOR)
        .ok_or(Mismatch::Overflow)
}

fn pool_share(stake: i128, creator_stake: i128, total: i128) -> Result<i128, Mismatch> {
    if total == 0 {
        return Ok(0);
    }
    stake
        .checked_mul(creator_stake)
        .map(|p| p / total)
        .ok_or(Mismatch::Overflow)
}

fn add(a: i128, b: i128) -> Result<i128, Mismatch> {
    a.checked_add(b).ok_or(Mismatch::Overflow)
}

fn check(leg: Leg, field: Field, expected: i128, found: i128) -> Result<(), Mismatch> {
    if expected == found {
        Ok(())
    } else {
        Err(Mismatch::Leg {
            leg,
            field,
            expected,
            found,
        })
    }
}

/// Non-empty, non-comment records with their 1-based line numbers and any
/// trailing `#` comment removed.
fn records(text: &str) -> impl Iterator<Item = (u32, &str)> {
    text.lines().enumerate().filter_map(|(i, raw)| {
        let line = match raw.find('#') {
            Some(at) => &raw[..at],
            None => raw,
        }
        .trim();
        if line.is_empty() {
            None
        } else {
            Some((i as u32 + 1, line))
        }
    })
}

fn parse_challenger(line: &str, line_no: u32) -> Result<Option<ChallengerLine>, Mismatch> {
    let mut parts = line.split_whitespace();
    if parts.next() != Some("challenger") {
        return Ok(None);
    }
    let bad = Mismatch::Malformed { line: line_no };
    let stake = parse_amount(parts.next(), line_no)?;
    let rest = [parts.next(), parts.next(), parts.next()];
    if parts.next().is_some() {
        return Err(bad);
    }
    let paid = match rest {
        [Some("-"), Some("-"), Some("-")] => None,
        [g, f, n] => Some((
            parse_amount(g, line_no)?,
            parse_amount(f, line_no)?,
            parse_amount(n, line_no)?,
        )),
    };
    Ok(Some(ChallengerLine { stake, paid }))
}

fn parse_amount(token: Option<&str>, line_no: u32) -> Result<i128, Mismatch> {
    let token = token.ok_or(Mismatch::Malformed { line: line_no })?;
    // Atomic integers only: no sign, no decimal point, no separators.
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Mismatch::Malformed { line: line_no });
    }
    token
        .parse::<i128>()
        .map_err(|_| Mismatch::Malformed { line: line_no })
}

fn parse_bps(token: Option<&str>, line_no: u32) -> Result<u32, Mismatch> {
    let token = token.ok_or(Mismatch::Malformed { line: line_no })?;
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Mismatch::Malformed { line: line_no });
    }
    token
        .parse::<u32>()
        .map_err(|_| Mismatch::Malformed { line: line_no })
}

fn parse_flag(token: Option<&str>, line_no: u32) -> Result<bool, Mismatch> {
    match token {
        Some("yes") => Ok(true),
        Some("no") => Ok(false),
        _ => Err(Mismatch::Malformed { line: line_no }),
    }
}

fn read_header(text: &str) -> Result<Header, Mismatch> {
    let mut iter = records(text);
    match iter.next() {
        Some((_, MANIFEST_HEADER_V1)) => {}
        _ => return Err(Mismatch::UnsupportedVersion),
    }

    let mut claim_id = None;
    let mut outcome = None;
    let mut mode = None;
    let mut payout_bps = None;
    let mut creator_stake = None;
    let mut platform_bps = None;
    let mut owner_bps = None;
    let mut platform_recipient = None;
    let mut owner_recipient = None;
    let mut creator_paid = None;
    let mut creator_fee = None;
    let mut remaining = None;

    for (line_no, line) in iter {
        let mut parts = line.split_whitespace();
        let key = parts.next();
        let value = parts.next();
        if key == Some("challenger") {
            continue;
        }
        if parts.next().is_some() {
            return Err(Mismatch::Malformed { line: line_no });
        }
        let bad = Mismatch::Malformed { line: line_no };
        // A record given twice is ambiguous, so it is refused.
        macro_rules! once {
            ($slot:ident, $val:expr) => {{
                if $slot.is_some() {
                    return Err(bad);
                }
                $slot = Some($val);
            }};
        }
        match key {
            Some("claim") => {
                let v = value.ok_or(bad)?;
                if !v.bytes().all(|b| b.is_ascii_digit()) || v.is_empty() {
                    return Err(bad);
                }
                once!(claim_id, v.parse::<u64>().map_err(|_| bad)?)
            }
            Some("winner") => once!(
                outcome,
                match value {
                    Some("creator") => Outcome::Creator,
                    Some("challengers") => Outcome::Challengers,
                    Some("draw") => Outcome::Draw,
                    Some("unresolvable") => Outcome::Unresolvable,
                    _ => return Err(bad),
                }
            ),
            Some("mode") => once!(
                mode,
                match value {
                    Some("pool") => Mode::Pool,
                    Some("fixed") => Mode::Fixed,
                    _ => return Err(bad),
                }
            ),
            Some("payout_bps") => once!(payout_bps, parse_bps(value, line_no)?),
            Some("creator_stake") => once!(creator_stake, parse_amount(value, line_no)?),
            Some("platform_fee_bps") => once!(platform_bps, parse_bps(value, line_no)?),
            Some("agent_owner_fee_bps") => once!(owner_bps, parse_bps(value, line_no)?),
            Some("platform_recipient") => once!(platform_recipient, parse_flag(value, line_no)?),
            Some("agent_owner_recipient") => once!(owner_recipient, parse_flag(value, line_no)?),
            Some("creator_paid") => once!(creator_paid, parse_amount(value, line_no)?),
            Some("creator_fee") => once!(creator_fee, parse_amount(value, line_no)?),
            Some("remaining") => once!(remaining, parse_amount(value, line_no)?),
            _ => return Err(bad),
        }
    }

    Ok(Header {
        claim_id: claim_id.ok_or(Mismatch::Missing { record: "claim" })?,
        outcome: outcome.ok_or(Mismatch::Missing { record: "winner" })?,
        mode: mode.ok_or(Mismatch::Missing { record: "mode" })?,
        payout_bps,
        creator_stake: creator_stake.ok_or(Mismatch::Missing {
            record: "creator_stake",
        })?,
        platform_bps: platform_bps.ok_or(Mismatch::Missing {
            record: "platform_fee_bps",
        })?,
        owner_bps: owner_bps.ok_or(Mismatch::Missing {
            record: "agent_owner_fee_bps",
        })?,
        platform_recipient: platform_recipient.ok_or(Mismatch::Missing {
            record: "platform_recipient",
        })?,
        owner_recipient: owner_recipient.ok_or(Mismatch::Missing {
            record: "agent_owner_recipient",
        })?,
        creator_paid: creator_paid.ok_or(Mismatch::Missing {
            record: "creator_paid",
        })?,
        creator_fee: creator_fee.ok_or(Mismatch::Missing {
            record: "creator_fee",
        })?,
        remaining: remaining.ok_or(Mismatch::Missing {
            record: "remaining",
        })?,
    })
}
