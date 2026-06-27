import {
  CSVMultisigTapscript,
  MnemonicIdentity,
  MultisigTapscript,
  networks,
  RestArkProvider,
  RestDelegateProvider,
  VtxoScript,
  type RelativeTimelock,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

const ALICE_SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const BOB_SEED_PHRASE =
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;

/** 1. Create user identities */
const aliceIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED_PHRASE, {
  isMainnet: false,
});
const bobIdentity = MnemonicIdentity.fromMnemonic(BOB_SEED_PHRASE, {
  isMainnet: false,
});

/** 2. Extract user x-only public keys */
const alicePubkey = await aliceIdentity.xOnlyPublicKey();
const bobPubkey = await bobIdentity.xOnlyPublicKey();

/** 3. Connect to operator */
const operator = new RestArkProvider(OPERATOR_URL);
const operatorInfo = await operator.getInfo();

/** 4. Extract operator x-only public key */
const operatorPubkey = hex.decode(operatorInfo.signerPubkey).slice(1);

/** 5. Extract operator unilateral exit timelock */
const exitTimelock = {
  value: BigInt(operatorInfo.unilateralExitDelay),
  type: "seconds",
} as const satisfies RelativeTimelock;

/** 6. Connect to delegate */
const delegate = new RestDelegateProvider(DELEGATE_URL);
const delegateInfo = await delegate.getDelegateInfo();

/** 7. Extract delegate x-only public key */
const delegatePubkey = hex.decode(delegateInfo.pubkey).slice(1);

/** 8. Construct 2-2 multisig tapscript with support for operator co-spend, delegation, and unilateral exit */
const multisigTapscript = new VtxoScript([
  // 2-2 spend with operator
  MultisigTapscript.encode({
    pubkeys: [alicePubkey, bobPubkey, operatorPubkey],
  }).script,
  // 2-2 renewal via delegate
  MultisigTapscript.encode({
    pubkeys: [alicePubkey, bobPubkey, delegatePubkey, operatorPubkey],
  }).script,
  // 2-2 spend without operator (unilateral exit)
  CSVMultisigTapscript.encode({
    pubkeys: [alicePubkey, bobPubkey],
    timelock: exitTimelock,
  }).script,
]);

/** 9. Log Alice public key, Bob public key, operator public key, delegate public key, exit timelock, tweaked public key, script public key, and address */
console.log({
  alicePubkey: hex.encode(alicePubkey),
  bobPubkey: hex.encode(bobPubkey),
  operatorPubkey: hex.encode(operatorPubkey),
  delegatePubkey: hex.encode(delegatePubkey),
  exitTimelock,
  tweakedPubKey: hex.encode(multisigTapscript.tweakedPublicKey),
  scriptPubKey: hex.encode(multisigTapscript.pkScript),
  address: multisigTapscript
    .address(networks.mutinynet.hrp, operatorPubkey)
    .encode(),
});
