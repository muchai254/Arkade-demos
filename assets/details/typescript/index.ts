import { RestIndexerProvider } from "@arkade-os/sdk";

const ASSET_ID =
  "952ce3af7dd640a80984962156b63e7b3d3f2726c22f46e14f81daac2297170b0000" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider(OPERATOR_URL);

/** 2. Fetch asset details */
const assetDetails = await indexer.getAssetDetails(ASSET_ID);

if (!assetDetails.controlAssetId) {
  throw new Error("Expected control asset", {
    cause: ASSET_ID,
  });
}

/** 3. Fetch control asset details */
const controlAssetDetails = await indexer.getAssetDetails(
  assetDetails.controlAssetId,
);

/** 4. Log details for both assets */
console.log({
  assetDetails,
  controlAssetDetails,
});
