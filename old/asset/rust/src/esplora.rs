use ark_client::Blockchain;
use ark_client::Error;
use ark_client::SpendStatus;
use ark_client::TxStatus;
use ark_core::ExplorerUtxo;
use bitcoin::Address;
use bitcoin::Amount;
use bitcoin::OutPoint;
use bitcoin::Transaction;
use bitcoin::Txid;
use std::collections::HashSet;

/// A minimal Esplora-backed [`Blockchain`] implementation.
///
/// `ark_client::Client` is generic over its chain source and the SDK does not ship a
/// ready-made one, so every consumer supplies its own. This is adapted from the
/// `ark-client-sample` crate in the Rust SDK repo.
pub struct EsploraClient {
    esplora_client: esplora_client::AsyncClient,
}

impl EsploraClient {
    pub fn new(url: &str) -> anyhow::Result<Self> {
        let builder = esplora_client::Builder::new(url);
        let esplora_client = builder.build_async()?;

        Ok(Self { esplora_client })
    }
}

impl Blockchain for EsploraClient {
    async fn find_outpoints(&self, address: &Address) -> Result<Vec<ExplorerUtxo>, Error> {
        let current_block_height = self
            .esplora_client
            .get_height()
            .await
            .map_err(Error::consumer)?;

        let script_pubkey = address.script_pubkey();
        let txs = self
            .esplora_client
            .scripthash_txs(&script_pubkey, None)
            .await
            .map_err(Error::consumer)?;

        let spent_outpoints: HashSet<OutPoint> = txs
            .iter()
            .flat_map(|tx| {
                tx.vin
                    .iter()
                    .filter(|input| {
                        input
                            .prevout
                            .as_ref()
                            .is_some_and(|prevout| prevout.scriptpubkey == script_pubkey)
                    })
                    .map(|input| OutPoint {
                        txid: input.txid,
                        vout: input.vout,
                    })
            })
            .collect();

        let utxos = txs
            .into_iter()
            .flat_map(|tx| {
                let txid = tx.txid;
                tx.vout
                    .iter()
                    .enumerate()
                    .filter(|(_, v)| v.scriptpubkey == script_pubkey)
                    .map(|(i, v)| {
                        let outpoint = OutPoint {
                            txid,
                            vout: i as u32,
                        };
                        let confirmations = match tx.status.block_height {
                            Some(confirmation_block_height) => {
                                match current_block_height.checked_sub(confirmation_block_height) {
                                    Some(x) => x + 1,
                                    None => 0,
                                }
                            }
                            None => 0,
                        };

                        ExplorerUtxo {
                            outpoint,
                            amount: Amount::from_sat(v.value),
                            confirmation_blocktime: tx.status.block_time,
                            confirmations: confirmations as u64,
                            is_spent: spent_outpoints.contains(&outpoint),
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        Ok(utxos)
    }

    async fn find_tx(&self, txid: &Txid) -> Result<Option<Transaction>, Error> {
        let option = self
            .esplora_client
            .get_tx(txid)
            .await
            .map_err(Error::consumer)?;

        Ok(option)
    }

    async fn get_tx_status(&self, txid: &Txid) -> Result<TxStatus, Error> {
        let info = self
            .esplora_client
            .get_tx_info(txid)
            .await
            .map_err(Error::consumer)?;

        Ok(TxStatus {
            confirmed_at: info.and_then(|s| s.status.block_time.map(|t| t as i64)),
        })
    }

    async fn get_output_status(&self, txid: &Txid, vout: u32) -> Result<SpendStatus, Error> {
        let status = self
            .esplora_client
            .get_output_status(txid, vout as u64)
            .await
            .map_err(Error::consumer)?;

        Ok(SpendStatus {
            spend_txid: status.as_ref().and_then(|s| s.txid),
        })
    }

    async fn broadcast(&self, tx: &Transaction) -> Result<(), Error> {
        self.esplora_client
            .broadcast(tx)
            .await
            .map_err(Error::consumer)?;

        Ok(())
    }

    async fn get_fee_rate(&self) -> Result<f64, Error> {
        Ok(1.0)
    }

    async fn broadcast_package(&self, _txs: &[&Transaction]) -> Result<(), Error> {
        unimplemented!("not needed by this demo");
    }
}
