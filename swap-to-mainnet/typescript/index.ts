import {
  buildOffchainTx,
  CSVMultisigTapscript,
  DelegateVtxo,
  networks,
  ReadonlySingleKey,
  RestArkProvider,
  RestDelegateProvider,
  RestIndexerProvider,
  SingleKey,
  Transaction,
  VHTLC,
} from "@arkade-os/sdk";
import { HDKey } from "@bitcoinerlab/descriptors-scure";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64, hex } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2tr, Script, SigHash } from "@scure/btc-signer";
import {
  keyAggExport,
  keyAggregate,
  nonceAggregate,
  nonceGen,
  Session,
} from "@scure/btc-signer/musig2.js";
import { type TaprootNode } from "@scure/btc-signer/payment.js";
import { tagSchnorr } from "@scure/btc-signer/utils.js";
import ky from "ky";

const SWAP_AMOUNT = 2_500n as const;
const MAINNET_ADDRESS = "tb1qmt3ue2senlg6ddgmr76hwsk0rdvdk4rgeaen7l" as const; // from faucet.mutinynet.com
const ALICE_SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;

const NETWORK = networks.mutinynet;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const BOLTZ_API = "https://api.boltz.mutinynet.arkade.sh" as const;
const MEMPOOL_API = "https://mempool.mutinynet.arkade.sh/api" as const;
const DUST = 330n;

/** Verify `MAINNET_ADDRESS` (used for claim) */
let mainnetPkScript: Uint8Array<ArrayBufferLike> | undefined;
try {
  console.log("Extracting mainnet pkScript:", [MAINNET_ADDRESS]);
  mainnetPkScript = OutScript.encode(Address(NETWORK).decode(MAINNET_ADDRESS)!);
} catch (_error) {
  throw new Error("Invalid MAINNET_ADDRESS", {
    cause: MAINNET_ADDRESS,
  });
}

/** Convert mnemonic phrase into 64 byte seed */
console.log("Converting user mnemonic phrase to seed...");
const userSeed = mnemonicToSeedSync(ALICE_SEED);

/** Derive BIP32 master node from seed */
console.log("Deriving user master node from seed...");
const userMasterNode = HDKey.fromMasterSeed(userSeed);

/** Derive BIP32 account node from master
 * - Purpose: Taproot (BIP86), hardened (indicated by the apostrophe)
 * - Coin type: Mainnet (indicated by '0') or Testnet (indicated by '1'), hardened
 * - Account: 0 (first account), hardened
 * - Change index: 0 (for receiving funds from external addresses), non-hardened
 * - Address index: 0 (first address), non-hardened
 */
console.log("Deriving user account node from master...");
const userAccountNode = userMasterNode.derive(
  `m/86'/${NETWORK === networks.bitcoin ? 0 : 1}'/0'/0/0`,
);

console.log("Deriving private key from account node...");
const userPrivkey = userAccountNode.privateKey!;

console.log("Setting up user identity...");
const userIdentity = SingleKey.fromPrivateKey(userAccountNode.privateKey!);
const userPubkey = await userIdentity.xOnlyPublicKey();
const userPubkeyCompressed = await userIdentity.compressedPublicKey();
console.log("User public key:", [hex.encode(userPubkey)]);

console.log("Connecting to Arkade operator...");
const operator = new RestArkProvider(OPERATOR_URL);
const operatorInfo = await operator.getInfo();
const operatorPubkey = await ReadonlySingleKey.fromPublicKey(
  hex.decode(operatorInfo.signerPubkey),
).xOnlyPublicKey();
const exitTimelock = {
  value: operatorInfo.unilateralExitDelay,
  type: "seconds",
} as const;
const checkpointTapscript = CSVMultisigTapscript.decode(
  hex.decode(operatorInfo.checkpointTapscript),
);
console.log("Operator public key:", [hex.encode(operatorPubkey)]);

console.log("Connecting to delegate...");
const delegate = new RestDelegateProvider(DELEGATE_URL);
const delegateInfo = await delegate.getDelegateInfo();
const delegatePubkey = await ReadonlySingleKey.fromPublicKey(
  hex.decode(delegateInfo.pubkey),
).xOnlyPublicKey();
console.log("Delegate public key:", [hex.encode(delegatePubkey)]);

console.log("Generating user tapscript...");
const userScript = new DelegateVtxo.Script({
  pubKey: userPubkey,
  serverPubKey: operatorPubkey,
  delegatePubKey: delegatePubkey,
  csvTimelock: exitTimelock,
});
const userAddress = userScript.address(NETWORK.hrp, operatorPubkey);
console.log("Generated user address:", [userAddress.encode()]);

console.log("Connecting to indexer...");
const indexer = new RestIndexerProvider(OPERATOR_URL);

console.log("Fetching inputs for user...");
const inputs = await indexer
  .getVtxos({
    scripts: [hex.encode(userAddress.pkScript)],
    spendableOnly: true,
  })
  .then(({ vtxos }) =>
    vtxos
      /** Filter out inputs with Arkade assets */
      .filter((input) => !input.assets?.length),
  );
const inputTotal = inputs.reduce((sum, input) => sum + BigInt(input.value), 0n);
console.log("User balance:", [inputTotal]);

if (inputTotal === 0n) {
  throw new Error(`Address not funded`, {
    cause: {
      address: userAddress.encode(),
    },
  });
}

console.log("Fetching chain swap limits...");
const limits = await ky
  .get(`${BOLTZ_API}/v2/swap/chain`)
  .json<{
    ARK: {
      BTC: {
        limits: {
          maximal: number;
          minimal: number;
        };
      };
    };
  }>()
  .then((data) => ({
    min: BigInt(data.ARK.BTC.limits.minimal),
    max: BigInt(data.ARK.BTC.limits.maximal),
  }));
console.log("Fetched chain swap limits:", limits);

if (SWAP_AMOUNT < limits.min) {
  throw new Error(`Amount below swap minimum`, {
    cause: {
      amount: SWAP_AMOUNT,
      minimum: limits.min,
    },
  });
}
if (SWAP_AMOUNT > limits.max) {
  throw new Error(`Amount above swap maximum`, {
    cause: {
      amount: SWAP_AMOUNT,
      maximum: limits.max,
    },
  });
}

console.log("Fetching recommended fee rate...");
const feeRate = await ky
  .get(`${MEMPOOL_API}/v1/fees/recommended`)
  .json<{
    fastestFee: number;
  }>()
  .then(({ fastestFee }) => BigInt(fastestFee));
console.log("Fetched recommended fee rate:", [feeRate]);

const preimage = randomBytes(32);
console.log("Generated preimage:", [hex.encode(preimage)]);

const swap = await ky
  .post(`${BOLTZ_API}/v2/swap/chain`, {
    json: {
      from: "ARK",
      to: "BTC",
      feeSatsPerByte: Number(feeRate),
      claimPublicKey: hex.encode(userPubkeyCompressed),
      refundPublicKey: hex.encode(userPubkeyCompressed),
      /** Amount to be locked on Arkade */
      userLockAmount: Number(SWAP_AMOUNT),
      preimageHash: hex.encode(sha256(preimage)),
    },
  })
  .json<{
    lockupDetails: {
      /** Amount to be paid on Arkade. */
      amount: number;
      /** Arkade lockup address where user will send funds. */
      lockupAddress: string;
      /** Boltz's public key for the lockup script. */
      serverPublicKey: string;
      /** Block heights for various timeout/refund scenarios. */
      timeouts: {
        refund: number;
        unilateralClaim: number;
        unilateralRefund: number;
        unilateralRefundWithoutReceiver: number;
      };
    };
    claimDetails: {
      /** Amount to be received on mainnet. */
      amount: number;
      /** Mainnet lockup address where Boltz will lock funds. */
      lockupAddress: string;
      /** Boltz's public key for the claim script. */
      serverPublicKey: string;
      /** Taproot script tree, used to reconstruct address */
      swapTree: {
        claimLeaf: {
          version: number;
          output: string;
        };
        refundLeaf: {
          version: number;
          output: string;
        };
      };
    };
    /** Boltz swap ID */
    id: string;
  }>();

const lockupAmount = BigInt(swap.lockupDetails.amount);
if (lockupAmount !== SWAP_AMOUNT) {
  throw new Error("Lockup amount does NOT match requested swap amount", {
    cause: {
      expected: SWAP_AMOUNT,
      received: lockupAmount,
    },
  });
}

const arkadeBoltzPubkey = await ReadonlySingleKey.fromPublicKey(
  hex.decode(swap.lockupDetails.serverPublicKey),
).xOnlyPublicKey();
const arkadeRefundLocktime = BigInt(swap.lockupDetails.timeouts.refund);
const arkadeUnilateralClaimDelay = {
  value: BigInt(swap.lockupDetails.timeouts.unilateralClaim),
  type: "seconds",
} as const;
const arkadeUnilateralRefundDelay = {
  value: BigInt(swap.lockupDetails.timeouts.unilateralRefund),
  type: "seconds",
} as const;
const arkadeUnilateralRefundWithoutReceiverDelay = {
  value: BigInt(swap.lockupDetails.timeouts.unilateralRefundWithoutReceiver),
  type: "seconds",
} as const;
const mainnetBoltzPubkeyCompressed = await ReadonlySingleKey.fromPublicKey(
  hex.decode(swap.claimDetails.serverPublicKey),
).compressedPublicKey();
const mainnetClaimLeaf = {
  script: hex.decode(swap.claimDetails.swapTree.claimLeaf.output),
  leafVersion: swap.claimDetails.swapTree.claimLeaf.version,
  weight: 51,
} as const satisfies TaprootNode;
const mainnetRefundLeaf = {
  script: hex.decode(swap.claimDetails.swapTree.refundLeaf.output),
  leafVersion: swap.claimDetails.swapTree.refundLeaf.version,
  weight: 49,
} as const satisfies TaprootNode;
const expectedClaimAmount = BigInt(swap.claimDetails.amount);

/** Reconstruct lockup address (Arkade) */
console.log("Reconstructing Arkade lockup address...");
const lockupScript = new VHTLC.Script({
  preimageHash: ripemd160(sha256(preimage)),
  sender: userPubkey,
  receiver: arkadeBoltzPubkey,
  server: operatorPubkey,
  refundLocktime: arkadeRefundLocktime,
  unilateralClaimDelay: arkadeUnilateralClaimDelay,
  unilateralRefundDelay: arkadeUnilateralRefundDelay,
  unilateralRefundWithoutReceiverDelay:
    arkadeUnilateralRefundWithoutReceiverDelay,
});
const lockupAddress = lockupScript.address(NETWORK.hrp, operatorPubkey);
const lockupInternalKey = keyAggExport(
  keyAggregate([mainnetBoltzPubkeyCompressed, userPubkeyCompressed]),
);

/** Reconstruct claim address (mainnet) */
console.log("Reconstructing mainnet lockup address...");
const {
  address: claimAddress,
  script: claimScript,
  tapInternalKey: claimTapInternalKey,
  tapMerkleRoot: claimTapMerkleRoot,
} = p2tr(
  lockupInternalKey,
  [mainnetClaimLeaf, mainnetRefundLeaf],
  NETWORK,
  true,
);

/** Ensure Arkade lockup address matches */
if (lockupAddress.encode() !== swap.lockupDetails.lockupAddress) {
  throw new Error("Derived Arkade lockup address does NOT match API response", {
    cause: {
      expected: lockupAddress.encode(),
      received: swap.lockupDetails.lockupAddress,
    },
  });
}
console.log("Validated Arkade lockup address:", [lockupAddress.encode()]);

/** Ensure mainnet claim address matches */
console.log("Validating mainnet claim address...");
if (claimAddress !== swap.claimDetails.lockupAddress) {
  throw new Error("Derived mainnet claim address does NOT match API response", {
    cause: {
      expected: claimAddress,
      received: swap.claimDetails.lockupAddress,
    },
  });
}
console.log("Validated mainnet claim address:", [claimAddress]);

console.log(`Created chain swap:`, {
  lockupAmount,
  lockupAddress: lockupAddress.encode(),
  expectedClaimAmount,
  claimAddress,
});

if (inputTotal < lockupAmount) {
  throw new Error(`Address does not have enough for swap`, {
    cause: {
      inputTotal,
      lockupAmount,
      need: lockupAmount - inputTotal,
      address: userAddress.encode(),
    },
  });
}

const changeAmount = inputTotal - lockupAmount;
const changeOutput =
  changeAmount < DUST
    ? {
        script: Script.encode(["RETURN", userAddress.subdustPkScript]),
        amount: changeAmount,
      }
    : {
        script: userAddress.pkScript,
        amount: changeAmount,
      };

console.log("Funding lockup address...");
const { arkTx: tx, checkpoints: checkpointTxs } = buildOffchainTx(
  inputs.map(({ txid, vout, value }) => ({
    txid,
    vout,
    value,
    /** Make input spendable */
    tapLeafScript: userScript.forfeit(),
    tapTree: userScript.encode(),
  })),
  [
    {
      script: lockupAddress.pkScript,
      amount: lockupAmount,
    },
    changeOutput,
  ],
  /** Unroll script (mandatory) */
  checkpointTapscript,
);
console.log("Generated transaction:", [base64.encode(tx.toPSBT())]);
console.log(
  "Generated unsigned checkpoint transactions:",
  checkpointTxs.map((tx) => base64.encode(tx.toPSBT())),
);

console.log("Signing...");
const signedTx = await userIdentity.sign(tx);
console.log("Signed Arkade transaction:", [base64.encode(signedTx.toPSBT())]);

console.log(
  "Submitting Arkade transaction with unsigned checkpoint transactions to operator...",
);
const { arkTxid: txid, signedCheckpointTxs } = await operator.submitTx(
  base64.encode(signedTx.toPSBT()),
  checkpointTxs.map((checkpointTx) => base64.encode(checkpointTx.toPSBT())),
);
console.log("Received signed checkpoint transactions:", signedCheckpointTxs);

console.log("Finalizing signed checkpoint transactions...");
const finalizedCheckpointTxs = await Promise.all(
  signedCheckpointTxs.map(async (signedCheckpointTx) => {
    let finalizedCheckpointTx = Transaction.fromPSBT(
      base64.decode(signedCheckpointTx),
    );
    console.log("Finalizing checkpoint transaction...");
    finalizedCheckpointTx = await userIdentity.sign(finalizedCheckpointTx);
    return base64.encode(finalizedCheckpointTx.toPSBT());
  }),
);
console.log("Finalized checkpoint transactions:", finalizedCheckpointTxs);

console.log("Finalizing transaction...");
await operator.finalizeTx(txid, finalizedCheckpointTxs);

console.log("Broadcasted!", `https://explorer.mutinynet.arkade.sh/tx/${txid}`);

console.log("Waiting (60 seconds remaining...)");
await new Promise((resolve) => setTimeout(resolve, 10_000));
console.log("Waiting (50 seconds remaining...)");
await new Promise((resolve) => setTimeout(resolve, 10_000));
console.log("Waiting (40 seconds remaining...)");
await new Promise((resolve) => setTimeout(resolve, 10_000));
console.log("Waiting (30 seconds remaining...)");
await new Promise((resolve) => setTimeout(resolve, 10_000));
console.log("Waiting (20 seconds remaining...)");
await new Promise((resolve) => setTimeout(resolve, 10_000));
console.log("Waiting (10 seconds remaining...)");
await new Promise((resolve) => setTimeout(resolve, 10_000));

console.log("Looking for mainnet claim output...");
const claimInput = await ky
  .get(`${MEMPOOL_API}/address/${claimAddress}/utxo`)
  .json<
    Array<{
      txid: string;
      vout: number;
      value: number;
    }>
  >()
  .then(([input]) => ({
    txid: input.txid,
    index: input.vout,
    value: BigInt(input.value),
  }));
console.log("Fetched mainnet claim input:", claimInput);

/** Create claim transaction (mainnet) */
console.log("Creating mainnet claim transaction...");
const claimTx = new Transaction({ version: 2 });
/** Add claim input */
claimTx.addInput({
  txid: claimInput.txid,
  index: claimInput.index,
  sequence: 0xfffffffd, // enable RBF
});
/** Add claim output */
claimTx.addOutput({
  amount: expectedClaimAmount - 100n, // TODO: Replace with dynamic calculation (reuse feeRate)
  script: mainnetPkScript!,
});
// Cooperative (key-path) spend: dummy signature placeholder
// Replaced later with the real aggregated MuSig2 signature
claimTx.updateInput(0, {
  finalScriptWitness: [new Uint8Array(64)],
});

/** Compute sighash message for MuSig2 */
const musigMessage = claimTx.preimageWitnessV1(
  0,
  [claimScript],
  SigHash.DEFAULT,
  [claimInput.value],
);

/** Generate our nonce */
console.log("Generating mainnet MuSig2 nonce for claim...");
const userNonce = nonceGen(
  userPubkeyCompressed,
  userPrivkey,
  lockupInternalKey,
  musigMessage,
);

/** Request co-signature from Boltz */
console.log("Requesting co-signature from Boltz (mainnet claim)...");
const { boltzNonce, boltzPartialSig } = await ky
  .post(`${BOLTZ_API}/v2/swap/chain/${swap.id}/claim`, {
    json: {
      preimage: hex.encode(preimage),
      toSign: {
        pubNonce: hex.encode(userNonce.public),
        transaction: claimTx.hex,
        index: 0,
      },
    },
  })
  .json<{
    pubNonce: string;
    partialSignature: string;
  }>()
  .then(({ pubNonce, partialSignature }) => ({
    boltzNonce: hex.decode(pubNonce),
    boltzPartialSig: hex.decode(partialSignature),
  }));

/** Combine Boltz signature with user's */
console.log("Combining Boltz signature with user...");
const tapTweak = tagSchnorr(
  "TapTweak",
  claimTapInternalKey,
  claimTapMerkleRoot,
);
const session = new Session(
  nonceAggregate([boltzNonce, userNonce.public]),
  [mainnetBoltzPubkeyCompressed, userPubkeyCompressed],
  musigMessage,
  [tapTweak],
  [true],
);
const userPartialSig = session.sign(userNonce.secret, userPrivkey);
const finalSig = session.partialSigAgg([boltzPartialSig, userPartialSig]);

/** Finalize witness and broadcast */
claimTx.updateInput(0, { finalScriptWitness: [finalSig] });
console.log("Broadcasting transaction...");
await ky.post(`${BOLTZ_API}/v2/chain/BTC/transaction`, {
  json: { hex: claimTx.hex },
});

console.log("Broadcasted!", `https://mutinynet.com/tx/${claimTx.id}`);
