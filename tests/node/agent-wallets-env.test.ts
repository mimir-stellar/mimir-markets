import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

import {
  councilEnvSlug,
  councilPublicEnv,
  councilSecretEnv,
  getCouncilAddress,
  getCouncilWallet,
  getCreatorWallet,
  getOracleWallet,
  loadAgentWallet,
  publicEnvName,
  secretEnvName,
} from "../../lib/agent-wallets";

test("secretEnvName maps roles to uppercase _SECRET env var names", () => {
  // Bare role names with hyphens and lower-case
  assert.equal(secretEnvName("oracle"), "ORACLE_SECRET");
  assert.equal(secretEnvName("creator"), "CREATOR_SECRET");
  assert.equal(secretEnvName("market-creator"), "MARKET_CREATOR_SECRET");
  assert.equal(secretEnvName("trader-alpha"), "TRADER_ALPHA_SECRET");
  assert.equal(secretEnvName("council-aristotle"), "COUNCIL_ARISTOTLE_SECRET");

  // Already uppercase with underscore
  assert.equal(secretEnvName("ORACLE"), "ORACLE_SECRET");
  assert.equal(secretEnvName("MARKET_CREATOR"), "MARKET_CREATOR_SECRET");

  // Already suffixed with _SECRET (idempotent)
  assert.equal(secretEnvName("ORACLE_SECRET"), "ORACLE_SECRET");
  assert.equal(secretEnvName("oracle_secret"), "ORACLE_SECRET");
  assert.equal(secretEnvName("market-creator_secret"), "MARKET_CREATOR_SECRET");
});

test("publicEnvName maps roles to uppercase _PUBLIC env var names and strips _SECRET", () => {
  // Bare role names
  assert.equal(publicEnvName("oracle"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("creator"), "CREATOR_PUBLIC");
  assert.equal(publicEnvName("market-creator"), "MARKET_CREATOR_PUBLIC");
  assert.equal(publicEnvName("trader-alpha"), "TRADER_ALPHA_PUBLIC");

  // Already uppercase
  assert.equal(publicEnvName("ORACLE"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("MARKET_CREATOR"), "MARKET_CREATOR_PUBLIC");

  // Replacing _SECRET with _PUBLIC
  assert.equal(publicEnvName("ORACLE_SECRET"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("oracle_secret"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("market-creator_secret"), "MARKET_CREATOR_PUBLIC");

  // Already suffixed with _PUBLIC (idempotent)
  assert.equal(publicEnvName("ORACLE_PUBLIC"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("oracle_public"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("council-aristotle_public"), "COUNCIL_ARISTOTLE_PUBLIC");
});

test("councilEnvSlug normalises persona slugs by uppercasing and replacing hyphens with underscores", () => {
  assert.equal(councilEnvSlug("aristotle"), "ARISTOTLE");
  assert.equal(councilEnvSlug("john-stuart-mill"), "JOHN_STUART_MILL");
  assert.equal(councilEnvSlug("thomas-aquinas"), "THOMAS_AQUINAS");
  assert.equal(councilEnvSlug("Ada-Lovelace"), "ADA_LOVELACE");
  assert.equal(councilEnvSlug("karl_marx"), "KARL_MARX");
});

test("councilSecretEnv and councilPublicEnv construct council env var names per persona slug", () => {
  assert.equal(councilSecretEnv("aristotle"), "COUNCIL_ARISTOTLE_SECRET");
  assert.equal(councilPublicEnv("aristotle"), "COUNCIL_ARISTOTLE_PUBLIC");

  assert.equal(councilSecretEnv("john-stuart-mill"), "COUNCIL_JOHN_STUART_MILL_SECRET");
  assert.equal(councilPublicEnv("john-stuart-mill"), "COUNCIL_JOHN_STUART_MILL_PUBLIC");

  assert.equal(councilSecretEnv("friedrich-nietzsche"), "COUNCIL_FRIEDRICH_NIETZSCHE_SECRET");
  assert.equal(councilPublicEnv("friedrich-nietzsche"), "COUNCIL_FRIEDRICH_NIETZSCHE_PUBLIC");
});

test("loadAgentWallet rejects missing env var with message naming the variable", () => {
  const env: Record<string, string | undefined> = {};

  assert.throws(
    () => loadAgentWallet("ORACLE", env),
    (err: Error) => {
      assert.match(err.message, /ORACLE_SECRET env var is required/);
      return true;
    },
  );

  assert.throws(
    () => loadAgentWallet("market-creator", env),
    (err: Error) => {
      assert.match(err.message, /MARKET_CREATOR_SECRET env var is required/);
      return true;
    },
  );

  // Whitespace-only string treated as missing
  assert.throws(
    () => loadAgentWallet("ORACLE", { ORACLE_SECRET: "   " }),
    (err: Error) => {
      assert.match(err.message, /ORACLE_SECRET env var is required/);
      return true;
    },
  );
});

test("loadAgentWallet rejects malformed seed naming the variable and never leaking the value", () => {
  const badSeeds = [
    "not-a-secret-seed",
    "SBWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW", // checksum failure
    "GDF2HVBX3KPIDWTSQUTUASSNPYMV42N7FCZ2QBHH7WU52OZPTOAOCB77", // public key instead of secret
    "S" + "0".repeat(55), // invalid characters (0 is not base32)
    "S" + "A".repeat(20), // wrong length
  ];

  for (const badSeed of badSeeds) {
    assert.throws(
      () => loadAgentWallet("ORACLE", { ORACLE_SECRET: badSeed }),
      (err: Error) => {
        // Must name the variable
        assert.match(err.message, /ORACLE_SECRET/);
        // Must NEVER contain the secret value
        assert.equal(
          err.message.includes(badSeed),
          false,
          `Error message should never leak the seed value: ${err.message}`,
        );
        return true;
      },
    );
  }
});

test("loadAgentWallet builds wallet offline with injected env object and handles trailing comments", () => {
  const keypair = Keypair.random();
  const validSecret = keypair.secret();

  // Clean secret
  const wallet = loadAgentWallet("ORACLE", { ORACLE_SECRET: validSecret });
  assert.equal(wallet.address, keypair.publicKey());
  assert.equal(wallet.signer.publicKey, keypair.publicKey());

  // Secret with trailing comment, CRLF and extra spaces
  const envWithComments = {
    ORACLE_SECRET: `${validSecret}  # worker seed from vault\r\n`,
  };
  const wallet2 = loadAgentWallet("ORACLE", envWithComments);
  assert.equal(wallet2.address, keypair.publicKey());

  // Bare role or full var name both work
  const wallet3 = loadAgentWallet("oracle", { ORACLE_SECRET: validSecret });
  assert.equal(wallet3.address, keypair.publicKey());

  const wallet4 = loadAgentWallet("ORACLE_SECRET", { ORACLE_SECRET: validSecret });
  assert.equal(wallet4.address, keypair.publicKey());
});

test("getCouncilAddress retrieves address safely without touching seed", () => {
  const keypair = Keypair.random();
  const pub = keypair.publicKey();

  const env = {
    COUNCIL_ARISTOTLE_PUBLIC: pub,
    COUNCIL_PLATO_PUBLIC: `${pub} # comment note\r\n`,
    COUNCIL_EMPTY_PUBLIC: "",
    COUNCIL_INVALID_PUBLIC: "not-a-valid-address",
  };

  assert.equal(getCouncilAddress("aristotle", env), pub);
  assert.equal(getCouncilAddress("plato", env), pub);
  assert.equal(getCouncilAddress("empty", env), undefined);
  assert.equal(getCouncilAddress("invalid", env), undefined);
  assert.equal(getCouncilAddress("missing", env), undefined);
});

test("getCouncilWallet loads council persona wallet with injected env", () => {
  const keypair = Keypair.random();
  const secret = keypair.secret();

  const env = {
    COUNCIL_ARISTOTLE_SECRET: secret,
  };

  const wallet = getCouncilWallet("aristotle", env);
  assert.equal(wallet.address, keypair.publicKey());
});

test("getOracleWallet and getCreatorWallet load respective wallets with injected env", () => {
  const oracleKeypair = Keypair.random();
  const creatorKeypair = Keypair.random();

  const env = {
    ORACLE_SECRET: oracleKeypair.secret(),
    CREATOR_SECRET: creatorKeypair.secret(),
  };

  const oracleWallet = getOracleWallet(env);
  assert.equal(oracleWallet.address, oracleKeypair.publicKey());

  const creatorWallet = getCreatorWallet(env);
  assert.equal(creatorWallet.address, creatorKeypair.publicKey());
});
