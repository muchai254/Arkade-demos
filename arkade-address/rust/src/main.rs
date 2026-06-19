use ark_core::script::{csv_sig_script, multisig_3_of_3_script, multisig_script};
use ark_core::{ArkAddress, Vtxo, UNSPENDABLE_KEY};
use ark_delegator::DelegatorClient;
use ark_rest::Client;
use bip39::Mnemonic;
use bitcoin::{
    bip32::{DerivationPath, Xpriv, Xpub},
    key::{PublicKey, Secp256k1},
    secp256k1::PublicKey as SecpPublicKey,
    taproot::TaprootBuilder,
};
use std::str::FromStr;

const ALICE_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ARK_SERVER_URL: &str = "https://arkade.computer";
const DEFAULT_DELEGATE_URL: &str = "https://delegate.arkade.money";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Convert mnemonic phrase into 64 byte seed
    println!("Converting mnemonic phrase to seed...");
    let mnemonic: Mnemonic = ALICE_MNEMONIC.parse()?;
    let seed = mnemonic.to_seed("");

    let secp = Secp256k1::new();

    // 2. Fetch Arkade operator info
    // Connecting first lets us use the network reported by the server instead of
    // hardcoding it, so this example works against mainnet, mutinynet or regtest.
    println!("Connecting to Arkade operator...");
    let client = Client::new(ARK_SERVER_URL.to_string())?;
    let server_info = client.get_info().await?;
    let network = server_info.network;
    println!("Connected to operator on network: [{network}]");

    // 3. Derive BIP32 master node from seed
    println!("Deriving master node from seed...");
    let master_xpriv = Xpriv::new_master(network, &seed)?;

    // 4. Derive BIP32 account node from master
    // - Purpose: Taproot (BIP86), hardened (indicated by the apostrophe)
    // - Coin type: Mainnet (indicated by '0'), hardened
    // - Account: 0 (first account), hardened
    // - Change index: 0 (for receiving funds from external addresses), non-hardened
    // - Address index: 0 (first address), non-hardened
    println!("Deriving account node from master...");
    let path = DerivationPath::from_str("m/86'/0'/0'/0/0")?;
    let child_xpriv = master_xpriv.derive_priv(&secp, &path)?;

    // 5. Extract 32-byte x-only public key by slicing off the prefix
    let xpub = Xpub::from_priv(&secp, &child_xpriv);
    let user_xonly = xpub.public_key.x_only_public_key().0;
    println!(
        "Extracted user public key: ['{}']",
        hex::encode(user_xonly.serialize())
    );

    // 6. Extract operator public key
    let server_xonly = server_info.signer_pk.x_only_public_key().0;
    println!(
        "Extracted operator public key: ['{}']",
        hex::encode(server_xonly.serialize())
    );

    // 7. Generate default tapscript
    println!("Generating default tapscript...");
    let unspendable_key: PublicKey = UNSPENDABLE_KEY.parse()?;
    let (unspendable_xonly, _) = unspendable_key.inner.x_only_public_key();

    let forfeit_script = multisig_script(server_xonly, user_xonly);
    let exit_script = csv_sig_script(server_info.unilateral_exit_delay, user_xonly);

    let mut builder = TaprootBuilder::new();
    builder = builder
        .add_leaf(1, forfeit_script.clone())
        .map_err(|e| anyhow::anyhow!("forfeit leaf error: {e}"))?;
    builder = builder
        .add_leaf(1, exit_script.clone())
        .map_err(|e| anyhow::anyhow!("exit leaf error: {e}"))?;
    let default_spend_info = builder
        .finalize(&secp, unspendable_xonly)
        .map_err(|_| anyhow::anyhow!("failed to finalize default taproot"))?;

    // 8. Encode default tapscript as Arkade address
    let default_address = ArkAddress::new(network, server_xonly, default_spend_info.output_key());
    println!(
        "Generated default Arkade address: ['{}']",
        default_address.encode()
    );

    // 9. Fetch delegate info
    println!("Connecting to delegate...");
    let delegate_url =
        std::env::var("DELEGATE_URL").unwrap_or_else(|_| DEFAULT_DELEGATE_URL.to_string());
    let delegate_info = DelegatorClient::new(delegate_url).info().await?;

    // 10. Extract delegate public key
    let delegate_xonly = SecpPublicKey::from_slice(&hex::decode(&delegate_info.pubkey)?)?
        .x_only_public_key()
        .0;
    println!(
        "Extracted delegate public key: ['{}']",
        hex::encode(delegate_xonly.serialize())
    );

    // 11. Generate delegate tapscript
    let delegate_script = multisig_3_of_3_script(user_xonly, delegate_xonly, server_xonly);

    let mut builder = TaprootBuilder::new();
    builder = builder
        .add_leaf(2, forfeit_script)
        .map_err(|e| anyhow::anyhow!("forfeit leaf error: {e}"))?;
    builder = builder
        .add_leaf(2, exit_script)
        .map_err(|e| anyhow::anyhow!("exit leaf error: {e}"))?;
    builder = builder
        .add_leaf(1, delegate_script)
        .map_err(|e| anyhow::anyhow!("delegate leaf error: {e}"))?;
    let delegate_spend_info = builder
        .finalize(&secp, unspendable_xonly)
        .map_err(|_| anyhow::anyhow!("failed to finalize delegate taproot"))?;

    // 12. Encode delegate tapscript as Arkade address
    let delegated_address =
        ArkAddress::new(network, server_xonly, delegate_spend_info.output_key());
    println!(
        "Generated delegated Arkade address: ['{}']",
        delegated_address.encode()
    );

    // 13. Validate against Arkade SDK helper
    let sdk_default = Vtxo::new_default(
        &secp,
        server_xonly,
        user_xonly,
        server_info.unilateral_exit_delay,
        network,
    )?;
    println!(
        "Default address matches address generated by Arkade SDK helper? [{}]",
        default_address.encode() == sdk_default.to_ark_address().encode()
    );

    let sdk_delegated = Vtxo::new_with_delegator(
        &secp,
        server_xonly,
        user_xonly,
        delegate_xonly,
        server_info.unilateral_exit_delay,
        network,
    )?;
    println!(
        "Delegated address matches address generated by Arkade SDK helper? [{}]",
        delegated_address.encode() == sdk_delegated.to_ark_address().encode()
    );

    Ok(())
}
