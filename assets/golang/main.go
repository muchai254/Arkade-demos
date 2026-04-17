package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"strconv"

	arkasset "github.com/arkade-os/arkd/pkg/ark-lib/asset"
	client "github.com/arkade-os/arkd/pkg/client-lib"
	clienttypes "github.com/arkade-os/arkd/pkg/client-lib/types"
	arksdk "github.com/arkade-os/go-sdk"
	logrus "github.com/sirupsen/logrus"
)

// decode from nsec using https://www.nostrly.com/nip-19-entity-decoder/
const PRIVATE_KEY = ""

// specify asset info
const (
	assetName     = "Golang Test Asset"
	assetTicker   = "GTA"
	assetDecimals = 6
	assetIcon     = "https://i.imgur.com/VxPZvIK.png"
)

// specify test amounts
const (
	issueAmount   uint64 = 100_000_000 // 100.000000 adjusted for 6 decimals
	reissueAmount uint64 = 123_456     //   0.123456 adjusted for 6 decimals
)

// helpers for creating human-readable balances
func truncateAssetID(assetID string) string {
	if len(assetID) <= 5 {
		return assetID
	}
	return assetID[:5] + "..."
}

func summarizeBalances(ctx context.Context, wallet arksdk.ArkClient, balance *client.Balance) string {
	var parts []string
	parts = append(parts, fmt.Sprintf("%.8f BTC", float64(balance.OffchainBalance.Total)/1e8))

	for assetID, amount := range balance.AssetBalances {
		ticker := truncateAssetID(assetID)
		details, err := wallet.Indexer().GetAsset(ctx, assetID)
		if err != nil {
			log.Fatalf("could not fetch details for %s...: %v", ticker, err)
		}

		decimals := 0
		for _, entry := range details.Metadata {
			switch string(entry.Key) {
			case "decimals":
				parsed, err := strconv.Atoi(string(entry.Value))
				if err == nil {
					decimals = parsed
				}
			case "ticker":
				if len(entry.Value) > 0 {
					ticker = string(entry.Value)
				}
			}
		}

		parts = append(parts, fmt.Sprintf("%.*f %s", decimals, float64(amount)/math.Pow10(decimals), ticker))
	}

	formatted, err := json.MarshalIndent(parts, "", "  ")
	if err != nil {
		log.Fatal(err)
	}

	return string(formatted)
}

// helpers for creating new asset
func formatMetadataEntry(key, value string) arkasset.Metadata {
	md, err := arkasset.NewMetadata(key, value)
	if err != nil {
		log.Fatal(err)
	}
	return *md
}

func formatMetadata(metadata ...arkasset.Metadata) []arkasset.Metadata {
	_, err := arkasset.NewMetadataList(metadata)
	if err != nil {
		log.Fatal(err)
	}
	return metadata
}

// replicates balance.available from TS SDK
func availableOffchainBalance(ctx context.Context, wallet arksdk.ArkClient) (uint64, error) {
	vtxos, err := wallet.ListSpendableVtxos(ctx)
	if err != nil {
		return 0, err
	}
	var total uint64
	for _, vtxo := range vtxos {
		if vtxo.IsRecoverable() {
			continue
		}
		total += vtxo.Amount
	}
	return total, nil
}

// helper for sweeping assets
func toReceiverAssets(assetBalances map[string]uint64) []clienttypes.Asset {
	assets := make([]clienttypes.Asset, 0, len(assetBalances))
	for assetID, amount := range assetBalances {
		assets = append(assets, clienttypes.Asset{AssetId: assetID, Amount: amount})
	}
	return assets
}

func main() {
	ctx := context.Background()
	logrus.SetOutput(io.Discard) // ignore subscription errors

	// create wallet
	wallet, err := arksdk.NewArkClient("")
	if err != nil {
		log.Fatal(err)
	}
	defer wallet.Stop()
	err = wallet.Init(ctx, "https://arkade.computer", PRIVATE_KEY, "password")
	if err != nil {
		log.Fatal(err)
	}
	err = wallet.Unlock(ctx, "password")
	if err != nil {
		log.Fatal(err)
	}
	synced := <-wallet.IsSynced(ctx)
	if synced.Err != nil || !synced.Synced {
		log.Fatalf("wallet sync failed: %v", synced.Err)
	}

	// get address
	address, err := wallet.NewOffchainAddress(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nCreated wallet with address: " + address)

	// get initial balance
	balance, err := wallet.Balance(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nFetched initial balances:", summarizeBalances(ctx, wallet, balance))

	// burn existing assets
	var burnTxLinks []string
	for assetID, amount := range balance.AssetBalances {
		burnTxID, err := wallet.BurnAsset(ctx, assetID, amount)
		if err != nil {
			log.Fatal(err)
		}
		burnTxLinks = append(burnTxLinks, "https://arkade.space/tx/"+burnTxID)
	}
	formattedBurnTxLinks, err := json.MarshalIndent(burnTxLinks, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nBurned", len(burnTxLinks), "existing assets:", string(formattedBurnTxLinks))
	balance, err = wallet.Balance(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nFetched updated balances:", summarizeBalances(ctx, wallet, balance))

	// create new control asset
	controlAssetMetadata := formatMetadata(
		formatMetadataEntry("ticker", "ctrl-"+assetTicker),
		formatMetadataEntry("icon", "https://i.imgur.com/wWvxudd.png"),
	)
	controlIssueTxID, controlAssetIDs, err := wallet.IssueAsset(ctx, 1, nil, controlAssetMetadata)
	if err != nil {
		log.Fatal(err)
	}
	if len(controlAssetIDs) != 1 {
		log.Fatalf("expected 1 control asset id, got %d", len(controlAssetIDs))
	}
	controlAssetID := controlAssetIDs[0].String()
	fmt.Println("\nIssued new control asset: https://arkade.space/tx/" + controlIssueTxID)
	balance, err = wallet.Balance(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nFetched updated balances:", summarizeBalances(ctx, wallet, balance))

	// create new asset with control asset
	assetMetadata := formatMetadata(
		formatMetadataEntry("name", assetName),
		formatMetadataEntry("ticker", assetTicker),
		formatMetadataEntry("decimals", strconv.Itoa(assetDecimals)),
		formatMetadataEntry("icon", assetIcon),
	)
	newIssueTxID, newAssetIDs, err := wallet.IssueAsset(
		ctx,
		issueAmount,
		clienttypes.ExistingControlAsset{ID: controlAssetID},
		assetMetadata,
	)
	if err != nil {
		log.Fatal(err)
	}
	if len(newAssetIDs) != 1 {
		log.Fatalf("expected 1 asset id, got %d", len(newAssetIDs))
	}
	newAssetID := newAssetIDs[0].String()
	fmt.Println("\nIssued new asset with control asset: https://arkade.space/tx/" + newIssueTxID)
	balance, err = wallet.Balance(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nFetched updated balances:", summarizeBalances(ctx, wallet, balance))

	// reissue same asset
	reissueTxID, err := wallet.ReissueAsset(ctx, newAssetID, reissueAmount)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nReissued same asset with control asset: https://arkade.space/tx/" + reissueTxID)
	balance, err = wallet.Balance(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nFetched updated balances:", summarizeBalances(ctx, wallet, balance))

	// sweep all funds to self
	availableBalance, err := availableOffchainBalance(ctx, wallet)
	if err != nil {
		log.Fatal(err)
	}
	receivers := []clienttypes.Receiver{{
		To:     address,
		Amount: availableBalance,
		Assets: toReceiverAssets(balance.AssetBalances),
	}}
	sweepTxID, err := wallet.SendOffChain(ctx, receivers)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nSent everything in wallet to self: https://arkade.space/tx/" + sweepTxID)
	balance, err = wallet.Balance(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("\nFetched updated balances:", summarizeBalances(ctx, wallet, balance))
}
