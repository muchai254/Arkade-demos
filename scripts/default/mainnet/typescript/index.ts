import {
  DefaultVtxo,
  MnemonicIdentity,
  type RelativeTimelock,
  RestArkProvider,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;

/** 1. Create user identity */
const userIdentity = MnemonicIdentity.fromMnemonic(SEED_PHRASE);

/** 2. Extract user x-only public key */
const userPubkey = await userIdentity.xOnlyPublicKey();

/** 3. Connect to operator */
const operator = new RestArkProvider();
const operatorInfo = await operator.getInfo();

/** 4. Extract operator x-only public key */
const operatorPubkey = hex.decode(operatorInfo.signerPubkey).slice(1);

/** 5. Extract operator unilateral exit timelock */
const exitTimelock = {
  value: BigInt(operatorInfo.unilateralExitDelay),
  type: "seconds",
} as const satisfies RelativeTimelock;

/** 6. Construct default tapscript */
const DEFAULT_VTXO_OPTIONS = {
  pubKey: userPubkey,
  serverPubKey: operatorPubkey,
  csvTimelock: exitTimelock,
} as const satisfies DefaultVtxo.Options;

const defaultTapscript = new DefaultVtxo.Script(DEFAULT_VTXO_OPTIONS);

/** 7. Log user public key, operator public key, exit timelock, tweaked public key, script public key, and address */
console.log({
  userPubkey: hex.encode(userPubkey),
  operatorPubkey: hex.encode(operatorPubkey),
  exitTimelock,
  tweakedPubKey: hex.encode(defaultTapscript.tweakedPublicKey),
  scriptPubKey: hex.encode(defaultTapscript.pkScript),
  address: defaultTapscript.address(undefined, operatorPubkey).encode(),
});
