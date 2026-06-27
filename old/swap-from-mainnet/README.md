## Swap from Mainnet Demo

Demonstrates:

1. setting up a mnemonic identity
2. modifying `sign` function to add custom PSBT field `ConditionWitness` to witness
3. connecting to operator + delegate and extracting necessary parameters
4. generating a delegated user address
5. creating or resuming a Boltz Mainnet > Arkade swap
  - if creating, verifying Boltz limits & getting recommended fee rate
6. reconstructing the Arkade + Bitcoin mainnet lockup addresses
  - if creating, verifying both against the Boltz response
7. looking for balance in the Arkade claim lockup address
8. creating and submitting a claim transaction sweeping to self if balance found

### TypeScript

`pnpm install && pnpm dev`
