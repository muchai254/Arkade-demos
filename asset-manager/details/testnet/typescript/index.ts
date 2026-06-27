import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  ReadonlyWallet,
  RestArkProvider,
  SingleKey,
} from "@arkade-os/sdk";
import { hex, utf8 } from "@scure/base";

const ASSET_ID =
  "9fcd56ae25d2278fd2be1c37d99f8c0420624634f3ba5300a703408b700948660000" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;

/** 1. Create read-only wallet with dummy identity */
const wallet = await ReadonlyWallet.create({
  identity: await SingleKey.fromRandomBytes().toReadonly(),
  arkProvider: new RestArkProvider(OPERATOR_URL),
  /**
   * Explicitly use in-memory storage
   * Defaults to IndexedDB if undefined
   */
  storage: {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  },
});

/** 2. Fetch asset details */
const assetDetails = await wallet.assetManager.getAssetDetails(ASSET_ID);

if (!assetDetails.controlAssetId) {
  throw new Error("Expected control asset in assetDetails", {
    cause: assetDetails,
  });
}

if (!(assetDetails.metadata && "customField" in assetDetails.metadata)) {
  throw new Error("Expected field 'customField' in assetDetails.metadata", {
    cause: assetDetails.metadata,
  });
}

/** 3. Fetch control asset details */
const controlAssetDetails = await wallet.assetManager.getAssetDetails(
  assetDetails.controlAssetId,
);

if (
  !(
    controlAssetDetails.metadata &&
    "customField" in controlAssetDetails.metadata
  )
) {
  throw new Error(
    "Expected field 'customField' in controlAssetDetails.metadata",
    {
      cause: controlAssetDetails.metadata,
    },
  );
}

/** 4. Summarize asset details */
console.log({
  assetId: assetDetails.assetId,
  supply: assetDetails.supply,
  metadata: {
    ...assetDetails.metadata,
    customField: utf8.encode(
      hex.decode(assetDetails.metadata.customField as string),
    ),
  },
  controlAsset: {
    assetId: controlAssetDetails.assetId,
    supply: controlAssetDetails.supply,
    metadata: {
      ...controlAssetDetails.metadata,
      customField: utf8.encode(
        hex.decode(controlAssetDetails.metadata.customField as string),
      ),
    },
  },
});
