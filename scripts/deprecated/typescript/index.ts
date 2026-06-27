import {
  DefaultVtxo,
  DelegateVtxo,
  MnemonicIdentity,
  type RelativeTimelock,
  RestArkProvider,
  RestDelegateProvider,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const DELEGATE_URL = "https://delegate.arkade.money" as const;

/** 1. Create user identity */
const userIdentity = MnemonicIdentity.fromMnemonic(SEED_PHRASE);

/** 2. Extract user x-only public key */
const userPubkey = await userIdentity.xOnlyPublicKey();

/** 3. Connect to operator */
const operator = new RestArkProvider();
const operatorInfo = await operator.getInfo();

/** 4. Extract deprecated operator x-only public keys */
const deprecatedOperatorPubkeys = operatorInfo.deprecatedSigners.map(
  ({ pubkey }) => hex.decode(pubkey).slice(1),
);

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

/** 8. Construct default + delegated tapscripts for each deprecated signer */
const deprecatedTapscripts = deprecatedOperatorPubkeys.map((operatorPubkey) => {
  const defaultTapscript = new DefaultVtxo.Script({
    pubKey: userPubkey,
    serverPubKey: operatorPubkey,
    csvTimelock: exitTimelock,
  });
  const delegatedTapscript = new DelegateVtxo.Script({
    pubKey: userPubkey,
    serverPubKey: operatorPubkey,
    delegatePubKey: delegatePubkey,
    csvTimelock: exitTimelock,
  });
  return { operatorPubkey, defaultTapscript, delegatedTapscript } as const;
});

/** 9. Log user public key, operator public key, delegate pubkey (if applicable), exit timelock, tweaked public key, script public key, and address for each deprecated tapscript */
console.log(
  deprecatedTapscripts.flatMap(
    ({ operatorPubkey, defaultTapscript, delegatedTapscript }) => [
      {
        userPubkey: hex.encode(userPubkey),
        operatorPubkey: hex.encode(operatorPubkey),
        exitTimelock,
        tweakedPubKey: hex.encode(defaultTapscript.tweakedPublicKey),
        scriptPubKey: hex.encode(defaultTapscript.pkScript),
        address: defaultTapscript.address(undefined, operatorPubkey).encode(),
      },
      {
        userPubkey: hex.encode(userPubkey),
        operatorPubkey: hex.encode(operatorPubkey),
        delegatePubkey: hex.encode(delegatePubkey),
        exitTimelock,
        tweakedPubKey: hex.encode(delegatedTapscript.tweakedPublicKey),
        scriptPubKey: hex.encode(delegatedTapscript.pkScript),
        address: delegatedTapscript.address(undefined, operatorPubkey).encode(),
      },
    ],
  ),
);
