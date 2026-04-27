import {
  type AssetMetadata,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  SingleKey,
  Wallet,
  type WalletBalance,
} from '@arkade-os/sdk'

// decode from nsec using https://www.nostrly.com/nip-19-entity-decoder/
const PRIVATE_KEY = "";
const identity = SingleKey.fromHex(PRIVATE_KEY);
try {
  identity.xOnlyPublicKey()
} catch (_e) {
  throw new Error("PRIVATE_KEY must be a valid hex-encoded private key")
}

// specify asset info
const metadata: AssetMetadata = {
  name: "TypeScript Test Asset",
  ticker: "TTA",
  decimals: 6,
  icon: 'https://i.imgur.com/VxPZvIK.png'
}

// specify test amounts
const issueAmount = 100_000_000; // 100.000000 adjusted for 6 decimals
const reissueAmount = 123_456; //   0.123456 adjusted for 6 decimals

// helper for creating human-readable balances
const summarizeBalances = async (balance: WalletBalance) => {
  const bitcoin = `${(balance.total / (10 ** 8)).toFixed(8)} BTC`;
  const assets = await Promise.all(balance.assets.map(({ assetId, amount }) => wallet.assetManager.getAssetDetails(assetId).then(details => {
    const truncatedAssetId = `${assetId.slice(0, 5)}...`
    if (!details) {
      throw new Error(`Could not fetch details for ${truncatedAssetId}`)
    }
    const { decimals, ticker } = details.metadata ?? {};
    const safeDecimals = decimals || 0;
    return `${(amount / (10 ** (safeDecimals))).toFixed(safeDecimals)} ${ticker || truncatedAssetId}`
  })))
  return JSON.stringify([
    bitcoin,
    ...assets
  ], null, 2)
}

// create wallet
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://arkade.computer',
  settlementConfig: false, // Don't auto-renew VTXOs
  storage: {
    // node doesn't have indexedDB, so we have to specify in-memory repos here
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  },
})

// get address
const address = await wallet.getAddress();
console.log(`Created wallet with address: ${address}`)

// get initial balance
let balance = await wallet.getBalance();
console.log('\nFetched initial balances:', await summarizeBalances(balance))

// burn existing assets
const burnTxIds = await Promise.all(balance.assets.map(asset => wallet.assetManager.burn(asset)));
console.log(`\nBurned ${burnTxIds.length} existing assets:`, JSON.stringify(burnTxIds.map(burnTxId => `https://arkade.space/tx/${burnTxId}`), null, 2))
balance = await wallet.getBalance();
console.log('\nFetched updated balances:', await summarizeBalances(balance))

// create new control asset
const { arkTxId: controlIssueTxId, assetId: controlAssetId } = await wallet.assetManager.issue({
  amount: 1,
  metadata: {
    ticker: `ctrl-${metadata.ticker}`,
    icon: 'https://i.imgur.com/wWvxudd.png'
  }
})
console.log(`\nIssued new control asset: https://arkade.space/tx/${controlIssueTxId}`)
balance = await wallet.getBalance();
console.log('\nFetched updated balances:', await summarizeBalances(balance))

// create new asset with control asset
const { arkTxId: newIssueTxId, assetId: newAssetId } = await wallet.assetManager.issue({
  controlAssetId,
  amount: issueAmount,
  metadata
})
console.log(`\nIssued new asset with control asset: https://arkade.space/tx/${newIssueTxId}`)
balance = await wallet.getBalance();
console.log('\nFetched updated balances:', await summarizeBalances(balance))

// reissue same asset
const reissueTxId = await wallet.assetManager.reissue({
  assetId: newAssetId,
  amount: reissueAmount
})
console.log(`\nReissued same asset with control asset: https://arkade.space/tx/${reissueTxId}`)
balance = await wallet.getBalance();
console.log('\nFetched updated balances:', await summarizeBalances(balance))

// sweep all funds to self
const sweepTxId = await wallet.send({
  address,
  amount: balance.available, // assuming zero fees
  assets: balance.assets,
})
console.log(`\nSent everything in wallet to self: https://arkade.space/tx/${sweepTxId}`)
balance = await wallet.getBalance();
console.log('\nFetched updated balances:', await summarizeBalances(balance))