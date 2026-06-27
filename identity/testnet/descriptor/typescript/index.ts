import { ReadonlyDescriptorIdentity } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const FINGERPRINT = "73c5da0a" as const; // Master key fingerprint derived from SEED_PHRASE
const PURPOSE = "86'" as const; // Taproot
const COIN_TYPE = "1'" as const; // Testnet
const ACCOUNT = "0'" as const; // Account #0
const XPUB =
  "tpubDDfvzhdVV4unsoKt5aE6dcsNsfeWbTgmLZPi8LQDYU2xixrYemMfWJ3BaVneH3u7DBQePdTwhpybaKRU95pi6PMUtLPBJLVQRpzEnjfjZzX" as const; // xpub derived from SEED_PHRASE at m/86'/0'/0'
const CHANGE_INDEX = "0" as const; // Change #0 (deposit)

/** 1. Create identity */
const identity = ReadonlyDescriptorIdentity.fromDescriptor(
  `tr([${FINGERPRINT}/${PURPOSE}/${COIN_TYPE}/${ACCOUNT}]${XPUB}/${CHANGE_INDEX}/*)`,
);

/** 2. Log public keys */
console.log({
  descriptor: identity.descriptor,
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
});
