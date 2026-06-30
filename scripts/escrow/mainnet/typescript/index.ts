import {
  CLTVMultisigTapscript,
  MnemonicIdentity,
  MultisigTapscript,
  RestArkProvider,
  VtxoScript,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

const BUYER_SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const SELLER_SEED_PHRASE =
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong" as const;
const ARBITER_SEED_PHRASE =
  "legal winner thank year wave sausage worth useful legal winner thank yellow" as const;

/** 1. Create identities */
const buyerIdentity = MnemonicIdentity.fromMnemonic(BUYER_SEED_PHRASE, {
  isMainnet: false,
});
const sellerIdentity = MnemonicIdentity.fromMnemonic(SELLER_SEED_PHRASE, {
  isMainnet: false,
});
const arbiterIdentity = MnemonicIdentity.fromMnemonic(ARBITER_SEED_PHRASE, {
  isMainnet: false,
});

/** 2. Extract x-only public keys */
const buyerPubkey = await buyerIdentity.xOnlyPublicKey();
const sellerPubkey = await sellerIdentity.xOnlyPublicKey();
const arbiterPubkey = await arbiterIdentity.xOnlyPublicKey();

/** 3. Connect to operator */
const operator = new RestArkProvider();
const operatorInfo = await operator.getInfo();

/** 4. Extract operator x-only public key */
const operatorPubkey = hex.decode(operatorInfo.signerPubkey).slice(1);

/** 5. Construct escrow tapscript with collaborative, dispute, and refund paths */
const escrowTapscript = new VtxoScript([
  // Path 1: Buyer and seller both agree
  MultisigTapscript.encode({
    pubkeys: [buyerPubkey, sellerPubkey, operatorPubkey],
  }).script,
  // Path 2: Arbiter resolves dispute
  MultisigTapscript.encode({
    pubkeys: [arbiterPubkey, operatorPubkey],
  }).script,
  // Path 3: Refund to buyer after 30 days
  CLTVMultisigTapscript.encode({
    pubkeys: [buyerPubkey, operatorPubkey],
    absoluteTimelock:
      BigInt(Math.floor(Date.now() / 1000)) + 60n * 60n * 24n * 30n,
  }).script,
]);

/** 6. Log buyer public key, seller public key, operator public key, delegate public key, tweaked public key, script public key, and address */
console.log({
  buyerPubkey: hex.encode(buyerPubkey),
  sellerPubkey: hex.encode(sellerPubkey),
  operatorPubkey: hex.encode(operatorPubkey),
  tweakedPubKey: hex.encode(escrowTapscript.tweakedPublicKey),
  scriptPubKey: hex.encode(escrowTapscript.pkScript),
  address: escrowTapscript.address(undefined, operatorPubkey).encode(),
});
