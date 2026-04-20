import {
  ArkAddress,
  buildOffchainTx,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MnemonicIdentity,
  MultisigTapscript,
  networks,
  ReadonlySingleKey,
  RestArkProvider,
  RestIndexerProvider,
  type TapLeafScript,
  Transaction,
  VtxoScript,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base';

// Where to sweep funds to -- take from Arkade.money
const SWEEP_ADDRESS = 'ark1q...';

// Can co-sign a payout/refund with either player, or sweep after a timeout
const ARBITER_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ARBITER_PATHS = [0, 1, 2];

// Can co-sign a payout/refund with the arbiter, or collaborate with player B to exit (with or without server)
const ALICE_SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ALICE_PATHS = [0, 3, 4];

// Can co-sign a payout/refund with the arbiter, or collaborate with player A to exit (with or without server)
const BOB_SEED = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const BOB_PATHS = [1, 3, 4]

// Used for path #4 (players unilaterally exit without server)
// const ONCHAIN_SEED = '...'

// Helper for generating escrow script
const generateEscrowScript = async (
  operator: Uint8Array<ArrayBufferLike>,
  arbiter: Uint8Array<ArrayBufferLike>,
  playerA: Uint8Array<ArrayBufferLike>,
  playerB: Uint8Array<ArrayBufferLike>,
  expiry: bigint = BigInt(Math.floor(Date.now() / 1000)) + (60n * 60n * 24n) // 24 hours from now
): Promise<[
  expiry: bigint,
  address: string,
  pkScript: string,
  tapTree: ReturnType<VtxoScript["encode"]>,
  tapLeafScripts: Array<TapLeafScript>,
]> => {
  const paths = [
    // Path 0: Player A paid out (wins wager or refunded)
    MultisigTapscript.encode({
      pubkeys: [operator, arbiter, playerA]
    }).script,
    // Path 1: Player B paid out (wins wager or refunded)
    MultisigTapscript.encode({
      pubkeys: [operator, arbiter, playerB]
    }).script,
    // Path 2: Arbiter can sweep after timeout
    CLTVMultisigTapscript.encode({
      pubkeys: [operator, arbiter],
      absoluteTimelock: expiry
    }).script,
    // Path 3: Players collaborate without arbiter
    MultisigTapscript.encode({
      pubkeys: [operator, playerA, playerB]
    }).script,
    // Path 4: Players collaborate without arbiter or server (unilateral exit)
    CSVMultisigTapscript.encode({
      pubkeys: [playerA, playerB],
      timelock: {
        value: providerInfo.unilateralExitDelay,
        type: 'seconds'
      }
    }).script,
  ]
  const escrowScript = new VtxoScript(paths);
  const tapLeafScripts = paths.map(path => escrowScript.findLeaf(hex.encode(path)))
  return [
    expiry,
    escrowScript.address(networks.bitcoin.hrp, operator).encode(),
    hex.encode(escrowScript.pkScript),
    escrowScript.encode(),
    tapLeafScripts
  ]
}

console.log('Connecting to operator...')
const arkProvider = new RestArkProvider('https://arkade.computer');
const providerInfo = await arkProvider.getInfo();

console.log('Setting up operator identity...')
const operatorIdentity = ReadonlySingleKey.fromPublicKey(hex.decode(providerInfo.signerPubkey))

console.log('Setting up arbiter identity...')
const arbiterIdentity = MnemonicIdentity.fromMnemonic(ARBITER_SEED, {});

console.log('Setting up Alice identity...')
const aliceIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED, {});

console.log('Setting up Bob identity...')
const bobIdentity = MnemonicIdentity.fromMnemonic(BOB_SEED, {});

console.log('Generating escrow address...')
const [expiry, address, pkScript, tapTree, tapLeafScripts] = await generateEscrowScript(
  ...(await Promise.all([
    operatorIdentity.xOnlyPublicKey(),
    arbiterIdentity.xOnlyPublicKey(),
    aliceIdentity.xOnlyPublicKey(),
    bobIdentity.xOnlyPublicKey()
  ])),
  1750000000n // June 2025 (i.e., already spendable)
)
console.log('Generated address:', address)
console.log('Expiry (absolute timelock):', expiry)

console.log('Connecting to indexer...')
const indexerProvider = new RestIndexerProvider('https://arkade.computer')

console.log('Checking spendable balance in escrow address...')
const vtxos = (await indexerProvider.getVtxos({
  scripts: [pkScript],
  spendableOnly: true,
})).vtxos
const balance = vtxos.reduce(
  (total, current) => total + BigInt(current.value),
  0n,
);
console.log('Balance:', balance)

// Dynamically decide which path to take based on the final digit of the balance
// (e.g. 330 = path 0, 332 = path 2)
if (balance > 0) {
  const tapLeafIndex = +balance.toString().slice(-1) % tapLeafScripts.length;
  const arbiterRequired = ARBITER_PATHS.includes(tapLeafIndex);
  const aliceRequired = ALICE_PATHS.includes(tapLeafIndex);
  const bobRequired = BOB_PATHS.includes(tapLeafIndex);
  console.log(`Choosing path #${tapLeafIndex}`, {
    arbiterRequired, aliceRequired, bobRequired
  })
  const tapLeafScript = tapLeafScripts[tapLeafIndex]

  if (tapLeafIndex === 4) {
    throw new Error('Unilateral exit logic not implemented in this example yet, see https://arkade-os.github.io/ts-sdk/#unilateral-exit')
  }

  console.log('Generating transaction...')
  const { arkTx: tx, checkpoints: checkpointTxs } = buildOffchainTx(
    // Map VTXOs into PSBT inputs
    vtxos.map(vtxo => ({
      txid: vtxo.txid,
      vout: vtxo.vout,
      value: vtxo.value,
      tapLeafScript,
      tapTree,
    })),
    // Sweep everything to SWEEP_ADDRESS
    [{
      amount: balance,
      script: ArkAddress.decode(SWEEP_ADDRESS).pkScript
    }],
    // Unroll script (mandatory)
    CSVMultisigTapscript.decode(
      hex.decode(providerInfo.checkpointTapscript)
    ));

  let signedTx = tx;
  if (arbiterRequired) {
    console.log('Signing with arbiter...')
    signedTx = await arbiterIdentity.sign(signedTx)
  }
  if (aliceRequired) {
    console.log('Signing with Alice...')
    signedTx = await aliceIdentity.sign(signedTx)
  }
  if (bobRequired) {
    console.log('Signing with Bob...')
    signedTx = await bobIdentity.sign(signedTx)
  }

  console.log('Submitting transaction...')
  const { arkTxid: txid, signedCheckpointTxs: signedCheckpointPsbts } = await arkProvider.submitTx(
    base64.encode(signedTx.toPSBT()),
    checkpointTxs.map((checkpointTx) => base64.encode(checkpointTx.toPSBT()))
  );

  console.log('Finalizing checkpoint transactions...')
  const finalizedCheckpointTxs = await Promise.all(
    signedCheckpointPsbts.map(async (signedCheckpointPsbt) => {
      let signedCheckpointTx = Transaction.fromPSBT(base64.decode(signedCheckpointPsbt));
      if (arbiterRequired) {
        console.log('Signing checkpoint transaction with arbiter...')
        signedCheckpointTx = await arbiterIdentity.sign(signedCheckpointTx);
      }
      if (aliceRequired) {
        console.log('Signing checkpoint transaction with Alice...')
        signedCheckpointTx = await aliceIdentity.sign(signedCheckpointTx);
      }
      if (bobRequired) {
        console.log('Signing checkpoint transaction with Bob...')
        signedCheckpointTx = await bobIdentity.sign(signedCheckpointTx);
      }
      return base64.encode(signedCheckpointTx.toPSBT());
    })
  );

  console.log('Finalizing transaction...')
  await arkProvider.finalizeTx(txid, finalizedCheckpointTxs);
  console.log('Broadcasted!', `https://arkade.space/tx/${txid}`)
}