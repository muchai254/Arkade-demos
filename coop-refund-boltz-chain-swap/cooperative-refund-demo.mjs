/**
 * cooperative-refund-demo.mjs
 * ===========================
 *
 * A standalone, heavily-commented demo of a cooperative BTC chain-swap refund
 * using the same core primitives Boltz uses:
 *
 * - MuSig from `boltz-core`
 * - Taproot tx/sighash from `@scure/btc-signer`
 * - secp256k1 keys from `@noble/curves`
 *
 * Install:
 *   npm init -y
 *   npm install boltz-core @scure/btc-signer @noble/curves @scure/base
 *
 * Run:
 *   node cooperative-refund-demo.mjs
 *
 * -----------------------------------------------------------------------------
 * What this demonstrates
 * -----------------------------------------------------------------------------
 *
 * Cooperative refund means:
 *
 * 1. The swap UTXO is locked to a Taproot output.
 * 2. The Taproot output key comes from a MuSig aggregate key, tweaked by the
 *    swap tree.
 * 3. To spend cooperatively, user + server both sign the Taproot key path.
 * 4. For each input, both sides:
 *      - use the same exact transaction
 *      - use the same exact participant ordering
 *      - use the same exact Taproot tweak/tree
 *      - derive the same exact witness-v1 sighash/preimage
 *      - exchange public nonces
 *      - create partial signatures
 *      - aggregate those partial signatures into a final Schnorr signature
 * 5. That final aggregate signature is placed in the witness.
 *
 * -----------------------------------------------------------------------------
 * Mapping to Boltz source
 * -----------------------------------------------------------------------------
 *
 * This mirrors the shape of boltz-web-app's cooperative signing flow
 * (see src/utils/claim.ts) and boltz-core's MuSig helpers:
 *
 * - createMusig(...)        -> Musig.create(...)
 * - tweakMusig(...)         -> TaprootUtils.tweakMusig(...)
 * - hashForWitnessV1(...)   -> tx.preimageWitnessV1(...)
 * - fresh session per input
 * - addPartial(...)
 * - aggregatePartials(...)
 *
 * In the real flow the client requests the server's partial signature over an
 * HTTP API. For a chain-swap REFUND that is `POST /v2/swap/chain/{id}/refund`
 * with `{ index, transaction, pubNonce }` and, unlike a CLAIM, NO preimage.
 *
 * -----------------------------------------------------------------------------
 * Important note
 * -----------------------------------------------------------------------------
 *
 * This demo uses:
 * - real MuSig session handling
 * - real Taproot witness-v1 preimage generation
 * - real final aggregate signatures, verified against the on-chain output key
 *
 * But it still uses:
 * - synthetic UTXOs
 * - a fake local server function instead of a real HTTP API
 * - a simplified demo TapTree rather than a real swap tree from backend data
 *
 * So it demonstrates the cooperative-signing PRIMITIVE correctly; it does not
 * talk to a live Boltz backend. The existing `swap-to-mainnet` demo shows the
 * full, networked cooperative (claim) flow against the real API.
 */

import { hex } from '@scure/base';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { Transaction, SigHash, p2tr } from '@scure/btc-signer';
import { Musig, TaprootUtils } from 'boltz-core';

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function short(value, chars = 16) {
  const asHex = typeof value === 'string' ? value : hex.encode(value);
  return asHex.slice(0, chars);
}

function toXOnly(pubkey33) {
  // Convert compressed 33-byte secp256k1 pubkey to x-only 32-byte pubkey
  return pubkey33.slice(1, 33);
}

function makeKeypair(name) {
  const privateKey = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(privateKey, true);

  return {
    name,
    privateKey,
    publicKey,
    xOnly: toXOnly(publicKey),
  };
}

// -----------------------------------------------------------------------------
// Shared participant ordering
// -----------------------------------------------------------------------------
//
// This is the MOST IMPORTANT bug-avoidance rule in the whole flow.
//
// Both parties must use the SAME ordered participant pubkey array.
// Example:
//
//   [serverPub, userPub]
//
// and not:
//
//   [userPub, serverPub]
//
// If the order differs, the MuSig coefficients/session differ and the partial
// signatures become invalid.
//

function createMusigFixed(localPrivateKey, participantPubkeysOrdered) {
  return Musig.create(
    new Uint8Array(localPrivateKey),
    participantPubkeysOrdered.map((p) => new Uint8Array(p)),
  );
}

// -----------------------------------------------------------------------------
// Demo TapTree
// -----------------------------------------------------------------------------
//
// In the real Boltz flow, the aggregate key is tweaked by the actual swap tree.
// Cooperative refund uses the key path, but the tweak still matters: the Taproot
// output key committed on-chain is `taptweak(musigInternalKey, merkleRoot(tree))`.
//
// This is a simplified placeholder tree just to preserve the architecture.
//
// IMPORTANT: the SAME logical tree must drive two things that have to agree:
//   - the locking script (via `@scure/btc-signer`'s p2tr), and
//   - the MuSig signing tweak (via boltz-core's TaprootUtils.tweakMusig).
// The two libraries name the leaf fields differently, so we keep one canonical
// definition and expose both representations from it.
//

function makeDemoTree() {
  // boltz-core leaf shape: { output, version }
  return [
    { output: new Uint8Array([0x51]), version: 0xc0 },
    { output: new Uint8Array([0x51]), version: 0xc0 },
  ];
}

function toScureTree(tree) {
  // @scure/btc-signer leaf shape: { script, leafVersion }
  return tree.map((leaf) => ({
    script: leaf.output,
    leafVersion: leaf.version,
  }));
}

// -----------------------------------------------------------------------------
// BTC witness-v1 preimage / sighash
// -----------------------------------------------------------------------------
//
// This mirrors Boltz's BTC path:
//
//   tx.preimageWitnessV1(index, scripts, SigHash.DEFAULT, amounts)
//

function hashForWitnessV1(inputs, tx, index) {
  return tx.preimageWitnessV1(
    index,
    inputs.map((i) => i.script),
    SigHash.DEFAULT,
    inputs.map((i) => i.amount),
  );
}

// -----------------------------------------------------------------------------
// Synthetic swap UTXOs
// -----------------------------------------------------------------------------
//
// These fake prevouts stand in for the on-chain swap outputs.
//

function makePrevouts(lockScript) {
  return [
    {
      txid: '11'.repeat(32),
      index: 0,
      amount: 120000n,
      script: lockScript,
    },
    {
      txid: '22'.repeat(32),
      index: 1,
      amount: 80000n,
      script: lockScript,
    },
  ];
}

// -----------------------------------------------------------------------------
// Build cooperative refund transaction
// -----------------------------------------------------------------------------
//
// We create a real tx object with real inputs and output script.
// Cooperative refund is a key-path spend, so lockTime is 0 here.
//

function buildRefundTransaction(prevouts, destinationScript, fee = 500n) {
  const total = prevouts.reduce((sum, p) => sum + p.amount, 0n);

  const tx = new Transaction({
    version: 2,
    lockTime: 0,
  });

  for (const prevout of prevouts) {
    tx.addInput({
      txid: prevout.txid,
      index: prevout.index,
      witnessUtxo: {
        script: prevout.script,
        amount: prevout.amount,
      },
      sighashType: SigHash.DEFAULT,
    });
  }

  tx.addOutput({
    script: destinationScript,
    amount: total - fee,
  });

  return tx;
}

// -----------------------------------------------------------------------------
// Simulated server side: getPartialRefundSignature(...)
// -----------------------------------------------------------------------------
//
// This mirrors the backend conceptually.
//
// What the client sends over the wire:
//
// - transaction (or tx hex)
// - input index
// - user public nonce
//
// What the server keeps private:
//
// - server private key
// - server secret nonce
//
// What the server returns:
//
// - server public nonce
// - server partial signature
//
// The server MUST use:
// - same tx
// - same input index
// - same participant ordering
// - same tweak/tree
// - same sighash
//

function getPartialRefundSignatureServer({
  serverKeys,
  userKeys,
  orderedPubkeys,
  tree,
  prevouts,
  tx,
  inputIndex,
  userPubNonce,
}) {
  // Same ordered participant list as client
  const keyAgg = createMusigFixed(serverKeys.privateKey, orderedPubkeys);
  const tweakedForSign = TaprootUtils.tweakMusig(keyAgg, tree);

  const sigHash = hashForWitnessV1(prevouts, tx, inputIndex);

  // Build message-bound MuSig state
  const withMsg = tweakedForSign.message(sigHash);

  // Server generates its secret/public nonce pair locally
  const withNonce = withMsg.generateNonce();

  // Server combines its nonce with the user public nonce
  const aggNonces = withNonce.aggregateNonces([
    [userKeys.publicKey, userPubNonce],
  ]);

  const session = aggNonces.initializeSession();

  // Server creates its own partial signature
  const signed = session.signPartial();

  return {
    pubNonce: withNonce.publicNonce,
    partialSignature: signed.ourPartialSignature,
  };
}

// -----------------------------------------------------------------------------
// Client side: sign one refund input cooperatively
// -----------------------------------------------------------------------------
//
// This mirrors the core loop from Boltz refundTaproot():
//
// - create fresh MuSig context per input
// - derive sigHash
// - generate pub nonce
// - ask server for partial
// - aggregate nonces
// - initialize session
// - sign our partial
// - add server partial
// - aggregate final signature
// - set witness
//

function signRefundInputClient({
  userKeys,
  serverKeys,
  orderedPubkeys,
  tree,
  prevouts,
  tx,
  inputIndex,
}) {
  // Fresh MuSig context per input
  const keyAgg = createMusigFixed(userKeys.privateKey, orderedPubkeys);

  // Same sighash/preimage both sides must sign
  const sigHash = hashForWitnessV1(prevouts, tx, inputIndex);

  const tweakedForSign = TaprootUtils.tweakMusig(keyAgg, tree);
  const withMsg = tweakedForSign.message(sigHash);

  // User generates local secret/public nonce
  const withNonce = withMsg.generateNonce();

  // This is what gets sent to the server:
  // - tx
  // - input index
  // - our public nonce
  const serverResp = getPartialRefundSignatureServer({
    serverKeys,
    userKeys,
    orderedPubkeys,
    tree,
    prevouts,
    tx,
    inputIndex,
    userPubNonce: withNonce.publicNonce,
  });

  // User combines server public nonce into aggregate nonce
  const aggNonces = withNonce.aggregateNonces([
    [serverKeys.publicKey, serverResp.pubNonce],
  ]);

  const session = aggNonces.initializeSession();

  // User partial
  const signed = session.signPartial();

  // Add server partial and verify it against the same session transcript
  const withServer = signed.addPartial(
    serverKeys.publicKey,
    serverResp.partialSignature,
  );

  // Aggregate to final Schnorr signature for key-path witness
  const finalSig = withServer.aggregatePartials();

  return {
    sigHash,
    userPubNonce: withNonce.publicNonce,
    serverPubNonce: serverResp.pubNonce,
    userPartialSignature: signed.ourPartialSignature,
    serverPartialSignature: serverResp.partialSignature,
    finalSignature: finalSig,
  };
}

// -----------------------------------------------------------------------------
// Main demo
// -----------------------------------------------------------------------------

function main() {
  console.log('\n=== Boltz-style cooperative BTC refund demo ===\n');

  // 1. Generate the two signers
  const userKeys = makeKeypair('user');
  const serverKeys = makeKeypair('server');

  console.log('1. Participants');
  console.log('   user pubkey:   ', short(userKeys.publicKey));
  console.log('   server pubkey: ', short(serverKeys.publicKey));

  // 2. Shared fixed participant ordering
  // This exact order must be used by BOTH sides
  const orderedPubkeys = [
    serverKeys.publicKey,
    userKeys.publicKey,
  ];

  // 3. Build aggregate MuSig key and tweak with demo tree
  const tree = makeDemoTree();
  const keyAgg = createMusigFixed(userKeys.privateKey, orderedPubkeys);

  console.log('\n2. MuSig aggregate');
  console.log('   agg pubkey:    ', short(keyAgg.aggPubkey));

  const tweaked = TaprootUtils.tweakMusig(keyAgg, tree);

  console.log('\n3. Tweaked output key');
  console.log('   output key:    ', short(tweaked.aggPubkey));

  // 4. Create synthetic Taproot swap output script
  //
  // The output key committed on-chain MUST equal the key the MuSig session
  // signs for. `tweaked.aggPubkey` is already the tweaked output key, so we
  // build the P2TR from the UNTWEAKED internal key (`keyAgg.aggPubkey`) plus
  // the same tree and let p2tr apply the (single) BIP341 tweak.
  //
  // Passing `tweaked.aggPubkey` to p2tr would tweak a second time, producing an
  // output key that no longer matches the signature -> the witness would be
  // rejected on broadcast. We assert the two derivations agree below.
  const lockup = p2tr(keyAgg.aggPubkey, toScureTree(tree), undefined, true);
  const lockScript = lockup.script;

  if (hex.encode(lockScript.slice(2)) !== hex.encode(tweaked.aggPubkey)) {
    throw new Error(
      'Locking output key does not match tweaked MuSig key (tweak mismatch)',
    );
  }

  console.log('\n4. Locking script');
  console.log('   script:        ', short(lockScript), '...');

  // 5. Synthetic swap UTXOs
  const prevouts = makePrevouts(lockScript);

  console.log('\n5. Swap UTXOs');
  prevouts.forEach((p, i) => {
    console.log(`   input ${i}: ${p.txid.slice(0, 12)}...:${p.index} amount=${p.amount}`);
  });

  // 6. Refund destination
  const refundReceiver = makeKeypair('refund-destination');
  const refundScript = p2tr(refundReceiver.xOnly).script;

  // 7. Build refund tx
  const tx = buildRefundTransaction(prevouts, refundScript, 500n);

  console.log('\n6. Refund tx built');
  console.log('   inputs:        ', prevouts.length);
  console.log('   outputs:       ', 1);

  // 8. Cooperatively sign each input
  console.log('\n7. Per-input cooperative signing');

  for (let inputIndex = 0; inputIndex < prevouts.length; inputIndex++) {
    console.log(`\n   --- input ${inputIndex} ---`);

    const result = signRefundInputClient({
      userKeys,
      serverKeys,
      orderedPubkeys,
      tree,
      prevouts,
      tx,
      inputIndex,
    });

    console.log('   A) witness-v1 preimage:   ', short(result.sigHash));
    console.log('   B) user pubnonce:         ', short(result.userPubNonce));
    console.log('   C) server pubnonce:       ', short(result.serverPubNonce));
    console.log('   D) server partial sig:    ', short(result.serverPartialSignature));
    console.log('   E) user partial sig:      ', short(result.userPartialSignature));
    console.log('   F) final schnorr sig:     ', short(result.finalSignature));

    // Verify the aggregate signature against the on-chain output key BEFORE
    // trusting it. This is the check that proves the cooperative signing (and
    // the tweak) actually produced a spendable key-path witness.
    const verified = schnorr.verify(
      result.finalSignature,
      result.sigHash,
      tweaked.aggPubkey,
    );
    if (!verified) {
      throw new Error(`Aggregate signature failed to verify for input ${inputIndex}`);
    }
    console.log('   G) signature verified:     ✓');

    // Key-path Taproot witness = [signature]
    tx.updateInput(inputIndex, {
      finalScriptWitness: [result.finalSignature],
    });
    console.log('   H) witness set');
  }

  // 9. Serialize the finalized transaction.
  //
  // Every input now carries a verified key-path witness, so the transaction is
  // fully finalized and `tx.hex` (a getter on @scure/btc-signer's Transaction)
  // returns the broadcastable hex.
  const txHex = tx.hex;

  console.log('\n8. Final tx hex');
  console.log(txHex);

  console.log('\n9. Key lesson');
  console.log('   Both parties must use the SAME ordered pubkey array.');
  console.log('   Only the local private key and local secret nonce differ.');
  console.log('   Everything else in the session transcript must match.');

  return { tx, txHex };
}

try {
  main();
} catch (err) {
  console.error('\nDemo failed:\n');
  console.error(err);
  process.exit(1);
}
