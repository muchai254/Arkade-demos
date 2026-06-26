import { RestIndexerProvider } from "@arkade-os/sdk";

const ASSET_ID =
  "84cd7bd2a66e2b0219b4bff398fdd4e65015aee00ef5a42023acc6ffd63542b30000" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider(OPERATOR_URL);

/** 2. Fetch asset details */
const assetDetails = await indexer.getAssetDetails(ASSET_ID);

if (!assetDetails.controlAssetId) {
  throw new Error("Expected control asset", {
    cause: {
      assetId: ASSET_ID,
    },
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
