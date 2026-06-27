import { SingleKey } from "@arkade-os/sdk";
import { hex, utf8 } from "@scure/base";

const PRIVATE_KEY =
  "dff1c8c2c016a572914b4c5adb8791d62b4768ae9d0a61be8ab94cf5038d7d90" as const;

/** 1. Create identity */
const identity = SingleKey.fromHex(PRIVATE_KEY);

/** 2. Log public keys and message signature */
console.log({
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
  signature: hex.encode(
    await identity.signMessage(utf8.decode("Hello World!")),
  ),
});
