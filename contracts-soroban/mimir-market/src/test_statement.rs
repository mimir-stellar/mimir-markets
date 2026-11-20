#![cfg(test)]

extern crate std;

use soroban_sdk::BytesN;

use crate::test_common::{Fixture, USDC};
use crate::types::{Error, WinnerSide};

#[test]
fn statement_exports_digest_inputs_and_alias_views_agree() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.question = f.str("Does the canonical statement round-trip?");
    params.context_hash = BytesN::from_array(&f.env, &[0x11u8; 32]);

    let id = f.client().create_claim(&creator, &params);
    let statement = f.client().get_claim_statement(&id);

    assert_eq!(statement.question, params.question);
    assert_eq!(statement.source_commitment, params.context_hash);
    assert_eq!(statement.deadline, params.deadline);
    assert_eq!(
        statement.digest,
        f.client().get_claim_statement_digest(&id),
        "digest-only view must agree with the full statement"
    );
    assert_eq!(
        statement,
        f.client().export_claim_statement(&id),
        "export alias must return the canonical statement"
    );
    assert_eq!(
        statement.digest,
        crate::util::claim_statement_digest(
            &f.env,
            &params.question,
            &params.context_hash,
            params.deadline,
        ),
        "contract digest must match the documented helper"
    );
}

#[test]
fn digest_matches_fixed_v1_reference_vector() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let params = f.params(10 * USDC);
    let id = f.client().create_claim(&creator, &params);

    let statement = f.client().get_claim_statement(&id);

    let expected = BytesN::from_array(
        &f.env,
        &[
            0x34, 0x3d, 0x25, 0x9a, 0xfc, 0xfe, 0x6e, 0x33, 0xbe, 0x95, 0x89, 0x32, 0x72, 0x51,
            0xca, 0x50, 0x7c, 0x11, 0xb7, 0xc2, 0x8b, 0x18, 0x02, 0x45, 0xbc, 0xdb, 0x5b, 0x25,
            0x4b, 0xb3, 0xf4, 0x46,
        ],
    );
    assert_eq!(
        statement.digest, expected,
        "v1 encoding must stay byte-for-byte stable for client verification"
    );
}

#[test]
fn digest_binds_question_source_commitment_and_deadline() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let base = f.params(10 * USDC);
    let base_id = f.client().create_claim(&creator, &base);
    let base_digest = f.client().get_claim_statement(&base_id).digest;

    let mut other_question = base.clone();
    other_question.question = f.str("Will it snow?");
    let question_id = f.client().create_claim(&creator, &other_question);
    assert_ne!(
        f.client().get_claim_statement(&question_id).digest,
        base_digest
    );

    let mut other_source = base.clone();
    other_source.context_hash = BytesN::from_array(&f.env, &[0x22u8; 32]);
    let source_id = f.client().create_claim(&creator, &other_source);
    assert_ne!(
        f.client().get_claim_statement(&source_id).digest,
        base_digest
    );

    let mut other_deadline = base;
    other_deadline.deadline += 1;
    let deadline_id = f.client().create_claim(&creator, &other_deadline);
    assert_ne!(
        f.client().get_claim_statement(&deadline_id).digest,
        base_digest
    );
}

#[test]
fn statement_is_stable_across_challenge_and_resolution() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);
    let params = f.params(10 * USDC);
    let id = f.client().create_claim(&creator, &params);
    let before = f.client().get_claim_statement(&id);

    f.client()
        .challenge_claim(&challenger, &id, &(2 * USDC), &None);
    f.advance_to(params.deadline + 1);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("confirmed"),
        &100,
        &f.zero_hash(),
    );

    assert_eq!(
        before,
        f.client().get_claim_statement(&id),
        "settlement must not rewrite the canonical statement"
    );
}

#[test]
fn unknown_claim_statement_fails_with_claim_not_found() {
    let f = Fixture::new(0, 0);

    let err = f
        .client()
        .try_get_claim_statement(&999)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimNotFound);

    let err = f
        .client()
        .try_get_claim_statement_digest(&999)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimNotFound);
}
