import {
  buildOffchainTx,
  ConditionWitness,
  CSVMultisigTapscript,
  DelegateVtxo,
  MnemonicIdentity,
  networks,
  ReadonlySingleKey,
  RestArkProvider,
  RestDelegatorProvider,
  RestIndexerProvider,
  setArkPsbtField,
  Transaction,
  VHTLC,
} from "@arkade-os/sdk";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64, hex } from "@scure/base";
import { keyAggExport, keyAggregate } from "@scure/btc-signer/musig2.js";
import { p2tr, type TaprootNode } from "@scure/btc-signer/payment.js";
import ky from "ky";

const PREIMAGE = "" as const;
const REFUND_LOCKTIME = 0n as const;
const LOCKUP_PUBKEY_COMPRESSED = "" as const;
const LOCKUP_CLAIM_LEAF_SCRIPT = "" as const;
const LOCKUP_REFUND_LEAF_SCRIPT = "" as const;
const SWAP_AMOUNT = 50_000n;

const ALICE_SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const NETWORK = networks.mutinynet;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const BOLTZ_API = "https://api.boltz.mutinynet.arkade.sh" as const;

const isNewSwap = hex.decode(PREIMAGE).length !== 32;
const preimage = isNewSwap ? randomBytes(32) : hex.decode(PREIMAGE);

if (
  !isNewSwap &&
  (Number.isNaN(Number(REFUND_LOCKTIME)) ||
    Math.floor(new Date().getTime() / 1000) > Number(REFUND_LOCKTIME))
) {
  throw new Error(
    "REFUND_LOCKTIME must be set to a valid future timestamp if PREIMAGE is defined",
    {
      cause: {
        REFUND_LOCKTIME,
      },
    },
  );
}

if (!isNewSwap && hex.decode(LOCKUP_PUBKEY_COMPRESSED).length !== 33) {
  throw new Error(
    "LOCKUP_PUBKEY_COMPRESSED must be set to a valid 33-byte compressed public key if PREIMAGE is defined",
    {
      cause: {
        LOCKUP_PUBKEY_COMPRESSED,
      },
    },
  );
}

if (!isNewSwap && hex.decode(LOCKUP_CLAIM_LEAF_SCRIPT).length !== 61) {
  throw new Error(
    "LOCKUP_CLAIM_LEAF_SCRIPT must be set to a valid 61-byte tap leaf script if PREIMAGE is defined",
    {
      cause: {
        LOCKUP_CLAIM_LEAF_SCRIPT,
      },
    },
  );
}

if (!isNewSwap && hex.decode(LOCKUP_REFUND_LEAF_SCRIPT).length !== 39) {
  throw new Error(
    "LOCKUP_REFUND_LEAF_SCRIPT must be set to a valid 39-byte tap leaf script if PREIMAGE is defined",
    {
      cause: {
        LOCKUP_REFUND_LEAF_SCRIPT,
      },
    },
  );
}

console.log("Setting up user identity...");
const _userIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED, {
  isMainnet: false,
});
console.log("Modifying signer to add ConditionWitness PSBT fields...");
const userIdentity = {
  xOnlyPublicKey: async () => await _userIdentity.xOnlyPublicKey(),
  compressedPublicKey: async () => await _userIdentity.compressedPublicKey(),
  sign: async (
    tx: Transaction,
    inputIndexes?: number[],
  ): Promise<Transaction> => {
    const clone = tx.clone();
    let signedTx = await _userIdentity.sign(clone, inputIndexes);
    signedTx = Transaction.fromPSBT(signedTx.toPSBT());
    for (const inputIndex of inputIndexes ||
      Array.from({ length: signedTx.inputsLength }, (_, i) => i)) {
      setArkPsbtField(signedTx, inputIndex, ConditionWitness, [preimage]);
    }
    return signedTx;
  },
};
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
const delegate = new RestDelegatorProvider(DELEGATE_URL);
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

let feeRate = 1n;

if (isNewSwap) {
  console.log("Fetching chain swap limits...");
  const limits = await ky
    .get(`${BOLTZ_API}/v2/swap/chain`)
    .json<{
      BTC: {
        ARK: {
          limits: {
            maximal: number;
            minimal: number;
          };
        };
      };
    }>()
    .then((data) => ({
      min: BigInt(data.BTC.ARK.limits.minimal),
      max: BigInt(data.BTC.ARK.limits.maximal),
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
}

console.log(
  isNewSwap ? "Creating chain swap..." : "Fetching chain swap details...",
);
const swap = await ky
  .post(`${BOLTZ_API}/v2/swap/chain`, {
    json: {
      from: "BTC",
      to: "ARK",
      feeSatsPerByte: Number(feeRate),
      claimPublicKey: hex.encode(userPubkeyCompressed),
      refundPublicKey: hex.encode(userPubkeyCompressed),
      /** Amount Boltz should lock on Arkade */
      serverLockAmount: Number(SWAP_AMOUNT),
      /** Use a random preimage in case PREIMAGE was defined */
      preimageHash: isNewSwap
        ? hex.encode(sha256(preimage))
        : hex.encode(sha256(randomBytes(32))),
    },
  })
  .json<{
    claimDetails: {
      /** Amount to be received on Arkade. */
      amount: number;
      /** Arkade lockup address where Boltz will lock funds. */
      lockupAddress: string;
      /** Boltz's public key for the claim script. */
      serverPublicKey: string;
      /** Block heights for various timeout/refund scenarios. */
      timeouts: {
        refund: number;
        unilateralClaim: number;
        unilateralRefund: number;
        unilateralRefundWithoutReceiver: number;
      };
    };
    lockupDetails: {
      /** Amount to be paid on mainnet. */
      amount: number;
      /** Mainnet lockup address where user will send funds. */
      lockupAddress: string;
      /** Boltz's public key for the lockup script. */
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
  }>();

if (BigInt(swap.claimDetails.amount) !== SWAP_AMOUNT) {
  throw new Error("Claim amount does NOT match requested swap amount", {
    cause: {
      expected: SWAP_AMOUNT,
      received: BigInt(swap.claimDetails.amount),
    },
  });
}

/** In a production scenario, all of the following should be saved from the original swap response. */
const refundPubkey = await ReadonlySingleKey.fromPublicKey(
  hex.decode(swap.claimDetails.serverPublicKey),
).xOnlyPublicKey();
const refundLocktime = isNewSwap
  ? BigInt(swap.claimDetails.timeouts.refund)
  : BigInt(REFUND_LOCKTIME);
const unilateralClaimDelay = {
  value: BigInt(swap.claimDetails.timeouts.unilateralClaim),
  type: "seconds",
} as const;
const unilateralRefundDelay = {
  value: BigInt(swap.claimDetails.timeouts.unilateralRefund),
  type: "seconds",
} as const;
const unilateralRefundWithoutReceiverDelay = {
  value: BigInt(swap.claimDetails.timeouts.unilateralRefundWithoutReceiver),
  type: "seconds",
} as const;
const lockupPubkeyCompressed = await ReadonlySingleKey.fromPublicKey(
  hex.decode(
    isNewSwap ? swap.lockupDetails.serverPublicKey : LOCKUP_PUBKEY_COMPRESSED,
  ),
).compressedPublicKey();
const lockupClaimLeaf = {
  script: hex.decode(
    isNewSwap
      ? swap.lockupDetails.swapTree.claimLeaf.output
      : LOCKUP_CLAIM_LEAF_SCRIPT,
  ),
  leafVersion: swap.lockupDetails.swapTree.claimLeaf.version,
  weight: 51,
} as const satisfies TaprootNode;
const lockupRefundLeaf = {
  script: hex.decode(
    isNewSwap
      ? swap.lockupDetails.swapTree.refundLeaf.output
      : LOCKUP_REFUND_LEAF_SCRIPT,
  ),
  leafVersion: swap.lockupDetails.swapTree.refundLeaf.version,
  weight: 49,
} as const satisfies TaprootNode;
const lockupAmount = BigInt(swap.lockupDetails.amount);

/** Reconstruct claim address (Arkade) */
console.log("Reconstructing Arkade claim address...");
const claimScript = new VHTLC.Script({
  preimageHash: ripemd160(sha256(preimage)),
  sender: refundPubkey,
  receiver: userPubkey,
  server: operatorPubkey,
  refundLocktime,
  unilateralClaimDelay,
  unilateralRefundDelay,
  unilateralRefundWithoutReceiverDelay,
});
const claimAddress = claimScript.address(NETWORK.hrp, operatorPubkey);

/** Reconstruct lockup address (mainnet) */
console.log("Reconstructing mainnet lockup address...");
const lockupAddress = p2tr(
  keyAggExport(keyAggregate([lockupPubkeyCompressed, userPubkeyCompressed])),
  [lockupClaimLeaf, lockupRefundLeaf],
  NETWORK,
  true,
).address;

if (isNewSwap) {
  /** Ensure claim address matches */
  console.log("Validating Arkade claim address...");
  if (claimAddress.encode() !== swap.claimDetails.lockupAddress) {
    throw new Error(
      "Derived Arkade claim address does NOT match API response",
      {
        cause: {
          expected: claimAddress.encode(),
          received: swap.claimDetails.lockupAddress,
        },
      },
    );
  }
  console.log("Validated Arkade claim address:", [claimAddress.encode()]);
  /** Ensure lockup address matches */
  console.log("Validating mainnet lockup address...");
  if (lockupAddress !== swap.lockupDetails.lockupAddress) {
    throw new Error(
      "Derived mainnet lockup address does NOT match API response",
      {
        cause: {
          expected: lockupAddress,
          received: swap.lockupDetails.lockupAddress,
        },
      },
    );
  }
  console.log("Validated mainnet lockup address:", [lockupAddress]);
  if (isNewSwap) {
    throw new Error(
      `
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
🚨      PREIMAGE, REFUND_LOCKTIME, LOCKUP_PUBKEY_COMPRESSED,        🚨
🚨     LOCKUP_CLAIM_LEAF_SCRIPT and LOCKUP_REFUND_LEAF_SCRIPT       🚨
🚨                        are not defined!                          🚨
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
`,
      {
        cause: {
          expectedClaimAmount: SWAP_AMOUNT,
          claimAddress: claimAddress.encode(),
          lockupAmount,
          lockupAddress,
          PREIMAGE: hex.encode(preimage),
          REFUND_LOCKTIME: refundLocktime,
          LOCKUP_PUBKEY_COMPRESSED: hex.encode(lockupPubkeyCompressed),
          LOCKUP_CLAIM_LEAF_SCRIPT: hex.encode(lockupClaimLeaf.script),
          LOCKUP_REFUND_LEAF_SCRIPT: hex.encode(lockupRefundLeaf.script),
        },
      },
    );
  }
} else {
  console.log(`Fetched chain swap:`, {
    expectedClaimAmount: SWAP_AMOUNT,
    claimAddress: claimAddress.encode(),
    lockupAmount,
    lockupAddress,
  });
}

console.log("Connecting to indexer...");
const indexer = new RestIndexerProvider(OPERATOR_URL);

console.log("Fetching inputs for claim address...");
const inputs = await indexer
  .getVtxos({
    scripts: [hex.encode(claimScript.pkScript)],
    spendableOnly: true,
  })
  .then(({ vtxos }) =>
    vtxos
      /** Filter out inputs with Arkade assets */
      .filter((input) => !input.assets?.length),
  );
const inputTotal = inputs.reduce((sum, input) => sum + BigInt(input.value), 0n);
console.log("Contract balance:", [inputTotal]);

if (inputTotal === 0n) {
  throw new Error(`Claim address not funded`, {
    cause: {
      address: claimAddress.encode(),
    },
  });
}

console.log("Generating claim transaction...");
const { arkTx: tx, checkpoints: checkpointTxs } = buildOffchainTx(
  inputs.map(({ txid, vout, value }) => ({
    txid,
    vout,
    value,
    /** Make input spendable */
    tapLeafScript: claimScript.claim(),
    tapTree: claimScript.encode(),
  })),
  [
    /** Sweep all to self */
    {
      script: userAddress.pkScript,
      amount: inputTotal,
    },
  ],
  /** Unroll script (mandatory) */
  checkpointTapscript,
);
console.log("Generated claim transaction:", [base64.encode(tx.toPSBT())]);
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
