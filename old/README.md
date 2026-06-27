# Arkade SDK Demos

- [asset](https://github.com/arkade-os/demos/tree/master/asset): demonstrates how to burn, issue, reissue and send Arkade Assets, and check their balances.
- [escrow](https://github.com/arkade-os/demos/tree/master/escrow): demonstrates how to construct a simple Tapscript-based escrow contract for a two-player game, with an arbiter facilitating payouts.
- [op-return](https://github.com/arkade-os/demos/tree/master/escrow): demonstrates how to create OP_RETURN messages and subdust outputs, and how to read them from the indexer.
- [onchain-address](https://github.com/arkade-os/demos/tree/master/onchain-address): demonstrates how to construct standard P2TR onchain address from scratch using the `@scure` libraries.
- [boarding-address](https://github.com/arkade-os/demos/tree/master/boarding-address): demonstrates how to construct Arkade boarding addresses from scratch using the `@scure` libraries and `VtxoScript` helper.
- [arkade-address](https://github.com/arkade-os/demos/tree/master/arkade-address): demonstrates how to construct both default + [delegated](https://docs.arkadeos.com/learn/concepts/lifecycle#how-delegation-works) addresses using the `@scure` libraries and lower-level Arkade SDK helpers.
- [delegate](https://github.com/arkade-os/demos/tree/master/delegate): demonstrates at a low-level how to submit a delegation intent to a [delegate](https://docs.arkadeos.com/learn/concepts/lifecycle#how-delegation-works), consolidating funds into a single settled output
- [swap-from-lightning](https://github.com/arkade-os/demos/tree/master/swap-from-lightning): demonstrates at a low-level how to create + claim a [Lightning > Arkade](https://docs.arkadeos.com/contracts/lightning-swaps#receiving-lightning-payments) VHTLC swap, powered by [Boltz](https://boltz.exchange/)
- [swap-to-lightning](https://github.com/arkade-os/demos/tree/master/swap-to-lightning): demonstrates at a low-level how to create + fund an [Arkade > Lightning](https://docs.arkadeos.com/contracts/lightning-swaps#sending-lightning-payments) VHTLC swap, powered by [Boltz](https://boltz.exchange/)
