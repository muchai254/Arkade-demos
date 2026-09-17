mod esplora;

use ark_bdk_wallet::Wallet;
use ark_client::InMemorySwapStorage;
use ark_client::OffChainBalance;
use ark_client::OfflineClient;
use ark_client::OfflineClientConfig;
use ark_core::asset::ControlAssetConfig;
use ark_core::send::SendReceiver;
use ark_core::Asset;
use bitcoin::key::Secp256k1;
use bitcoin::secp256k1::SecretKey;
use bitcoin::Network;
use esplora::EsploraClient;
use std::str::FromStr;
use std::sync::Arc;

// decode from nsec using https://www.nostrly.com/nip-19-entity-decoder/
const PRIVATE_KEY: &str = "";

// specify asset info
const ASSET_NAME: &str = "Rust Test Asset";
const ASSET_TICKER: &str = "RTA";
const ASSET_DECIMALS: u32 = 6;
const ASSET_ICON: &str = "https://i.imgur.com/VxPZvIK.png";

// specify test amounts
const ISSUE_AMOUNT: u64 = 100_000_000; // 100.000000 adjusted for 6 decimals
const REISSUE_AMOUNT: u64 = 123_456; //   0.123456 adjusted for 6 decimals

// the Rust SDK needs its own chain source and explorer links are built by hand
const ESPLORA_URL: &str = "https://mempool.space/api";
const EXPLORER_URL: &str = "https://arkade.space/tx";

type ArkClient = ark_client::Client<EsploraClient, Wallet, InMemorySwapStorage>;

// the SDK takes asset metadata as key-value pairs rather than a typed struct
fn asset_metadata() -> Vec<(String, String)> {
    vec![
        ("name".to_string(), ASSET_NAME.to_string()),
        ("ticker".to_string(), ASSET_TICKER.to_string()),
        ("decimals".to_string(), ASSET_DECIMALS.to_string()),
        ("icon".to_string(), ASSET_ICON.to_string()),
    ]
}

fn control_asset_metadata() -> Vec<(String, String)> {
    vec![
        ("ticker".to_string(), format!("ctrl-{ASSET_TICKER}")),
        (
            "icon".to_string(),
            "https://i.imgur.com/wWvxudd.png".to_string(),
        ),
    ]
}

// metadata comes back from the SDK as one opaque string, so pull single values
// out of it, accepting either a JSON object or comma-separated `key=value` pairs
fn metadata_value(metadata: &str, key: &str) -> Option<String> {
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(metadata) {
        if let Some(value) = map.get(key) {
            return Some(match value.as_str() {
                Some(string) => string.to_string(),
                None => value.to_string(),
            });
        }
    }

    metadata.split(',').find_map(|pair| {
        let (found, value) = pair.split_once('=')?;
        (found.trim() == key).then(|| value.trim().to_string())
    })
}

// helper for creating human-readable balances
async fn summarize_balances(
    client: &ArkClient,
    balance: &OffChainBalance,
) -> anyhow::Result<String> {
    let bitcoin = format!("{:.8} BTC", balance.total().to_sat() as f64 / 1e8);

    let mut summaries = vec![bitcoin];
    for (asset_id, amount) in balance.asset_balances() {
        let truncated_asset_id = format!("{}...", &asset_id.to_string()[..5]);
        let details = client.get_asset(*asset_id).await.map_err(|e| {
            anyhow::anyhow!("could not fetch details for {truncated_asset_id}: {e}")
        })?;

        let decimals = metadata_value(&details.metadata, "decimals")
            .and_then(|decimals| decimals.parse::<usize>().ok())
            .unwrap_or(0);
        let ticker = metadata_value(&details.metadata, "ticker").unwrap_or(truncated_asset_id);

        let scaled = *amount as f64 / 10f64.powi(decimals as i32);
        summaries.push(format!("{scaled:.decimals$} {ticker}"));
    }

    Ok(serde_json::to_string_pretty(&summaries)?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // esplora talks HTTPS, which needs a crypto provider installed up front
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");

    // create wallet
    let secp = Secp256k1::new();
    let keypair = SecretKey::from_str(PRIVATE_KEY)?.keypair(&secp);
    let blockchain = Arc::new(EsploraClient::new(ESPLORA_URL)?);
    let wallet = Arc::new(Wallet::new(keypair, Network::Bitcoin, ESPLORA_URL)?);
    let storage = Arc::new(InMemorySwapStorage::new());
    let client = OfflineClient::with_keypair(
        // the default config already targets mainnet
        OfflineClientConfig::default(),
        keypair,
        blockchain,
        wallet,
        storage,
    )
    .connect()
    .await
    .map_err(|e| anyhow::anyhow!(e))?;

    // get address
    let (address, _) = client
        .get_offchain_address()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!("Created wallet with address: {}", address.encode());

    // get initial balance
    let mut balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched initial balances: {}",
        summarize_balances(&client, &balance).await?
    );

    // burn existing assets
    let mut burn_tx_ids = Vec::new();
    for (asset_id, amount) in balance.asset_balances().clone() {
        let burn_tx_id = client
            .burn_asset(asset_id, amount)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        burn_tx_ids.push(format!("{EXPLORER_URL}/{burn_tx_id}"));
    }
    println!(
        "\nBurned {} existing assets: {}",
        burn_tx_ids.len(),
        serde_json::to_string_pretty(&burn_tx_ids)?
    );
    balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched updated balances: {}",
        summarize_balances(&client, &balance).await?
    );

    // create new control asset
    let control_issuance = client
        .issue_asset(1, None, Some(control_asset_metadata()))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let control_asset_id = *control_issuance
        .asset_ids
        .first()
        .ok_or_else(|| anyhow::anyhow!("control asset issuance returned no asset id"))?;
    println!(
        "\nIssued new control asset: {EXPLORER_URL}/{}",
        control_issuance.ark_txid
    );
    balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched updated balances: {}",
        summarize_balances(&client, &balance).await?
    );

    // create new asset with control asset
    let new_issuance = client
        .issue_asset(
            ISSUE_AMOUNT,
            Some(ControlAssetConfig::existing(control_asset_id)),
            Some(asset_metadata()),
        )
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let new_asset_id = *new_issuance
        .asset_ids
        .first()
        .ok_or_else(|| anyhow::anyhow!("asset issuance returned no asset id"))?;
    println!(
        "\nIssued new asset with control asset: {EXPLORER_URL}/{}",
        new_issuance.ark_txid
    );
    balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched updated balances: {}",
        summarize_balances(&client, &balance).await?
    );

    // reissue same asset
    let reissue_tx_id = client
        .reissue_asset(new_asset_id, REISSUE_AMOUNT)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!("\nReissued same asset with control asset: {EXPLORER_URL}/{reissue_tx_id}");
    balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched updated balances: {}",
        summarize_balances(&client, &balance).await?
    );

    // sweep all funds to self
    let assets = balance
        .asset_balances()
        .iter()
        .map(|(asset_id, amount)| Asset {
            asset_id: *asset_id,
            amount: *amount,
        })
        .collect();
    let sweep_tx_id = client
        .send(vec![SendReceiver {
            address,
            // the TS demo sends `balance.available`; the Rust SDK splits that out,
            // and only confirmed plus pre-confirmed funds are spendable offchain
            amount: balance.confirmed() + balance.pre_confirmed(), // assuming zero fees
            assets,
        }])
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!("\nSent everything in wallet to self: {EXPLORER_URL}/{sweep_tx_id}");
    balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched updated balances: {}",
        summarize_balances(&client, &balance).await?
    );

    Ok(())
}
