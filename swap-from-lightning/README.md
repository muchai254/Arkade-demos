## Swap from Lightning Demo

Demonstrates:

1. setting up a mnemonic identity
2. modifying `sign` function to add custom PSBT field `ConditionWitness` to witness
3. connecting to operator + delegate and extracting necessary parameters
4. creating or resuming a Boltz Lightning > Arkade swap
5. verifying the lockup address if creating a new swap
6. looking for balance in the lockup address
7. creating and submitting a claim transaction if balance found

### TypeScript

`pnpm install && pnpm dev`
