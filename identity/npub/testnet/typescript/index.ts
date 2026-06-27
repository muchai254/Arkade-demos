import { ReadonlySingleKey } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { nip19 } from "nostr-tools";

const NPUB =
  "npub1qf2n2h9g8jtn78vhec8rss7gt4ufqkh3ddxu2vdufz89wgfdyvq3vyu84ym" as const;

/** 1. Decode public key from nsec */
const publicKey = nip19.decode(NPUB).data;

/** 2. Create identity */
const identity = ReadonlySingleKey.fromPublicKey(hex.decode(publicKey));

/** 3. Log public keys */
console.log({
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
});
