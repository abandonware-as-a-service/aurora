# AURORA — DuskVM Commit–Reveal Puzzle Vaults & Moonlight Bounty Protocol

**Aurora** is an interactive on-chain cryptographic puzzle & bounty game built for the **Dusk Network** ecosystem using **Dusk Forge 0.3**, **Dusk Core 1.6**, **Dusk Data-Driver**, and **Dusk Connect (`@dusk-network/connect`)**.

It uses 100% public **Moonlight** accounts (`abi::public_sender()`, `BlsPublicKey`, `privacy: "public"`) while solving two classic public-blockchain challenges:
1. **Mempool Front-Running Immunity (2-Step Commit–Reveal):**
   - Anyone can lock a real Moonlight DUSK bounty behind a 32-byte SHA-256 answer digest (`SHA-256("aurora:answer:v1:" || normalized_answer)`).
   - If a solver simply submitted the plaintext answer in a public transaction, mempool sniper bots could copy the answer and steal the bounty.
   - Instead, solvers first submit `commit_solution(vault_id, commitment)` where:
     $$\text{commitment} = \text{SHA-256}(\text{"aurora:commit:v1:"} \parallel \text{vault\_id}_{\text{le64}} \parallel \text{solver\_pk}_{96} \parallel \text{answer\_hash}_{32} \parallel \text{salt})$$
   - After at least `MIN_REVEAL_DELAY = 1` block, the solver calls `reveal_solution(...)` with the plaintext answer and salt. Even if a mempool bot copies the commitment hash or intercepts the reveal transaction, the contract rejects the bot because the commitment is cryptographically bound to the solver's 96-byte `BlsPublicKey`.
2. **Opt-In Leaderboard Privacy on Public State:**
   - When revealing a solution (`reveal_solution`), or at any time afterward via `set_disclosure(disclose, alias)`, a solver chooses whether to **disclose** their identity on the leaderboard:
     - **Disclosed (`disclose = true`):** The contract exposes their chosen public alias and `BlsPublicKey` in `vault_winner`, `solver_entry`, and the `VaultCracked` event.
     - **Anonymous Shadow (`disclose = false`):** The solver still receives the full Moonlight DUSK payout via `TRANSFER_CONTRACT`, but the contract masks their `BlsPublicKey` as `None` (`null` in JSON) in all getters and events, displaying a deterministic pseudonymous tag (`Shadow #xxxxxx`) instead.

---

## Project Structure

- `contract/` — Rust smart contract crate (`dusk-aurora`) compiled to:
  - `app/vendor/dusk-aurora.wasm` (`--features contract`)
  - `app/vendor/aurora-driver.wasm` (`--features data-driver-js`)
- `vm-test/` — Simulated `TRANSFER_CONTRACT` (`transfer_mock.rs`) and deterministic BLS12-381 Moonlight key generator (`src/main.rs`).
- `app/` — Web Application & DuskVM WebAssembly Runtime:
  - `app/config.js` — Immutable production network & contract configuration (`Object.freeze`).
  - `app/dusk-vm.js` — Pure WebAssembly `piecrust-uplink` host runtime executing `dusk-aurora.wasm` and `transfer-mock.wasm`.
  - `app/node-sim.js` — Stateful simulated Dusk Node for automated integration testing (`npm test`).
  - `app/client.js` — Dusk Connect (`createDuskApp`, `readContract`, `prepareContractCall`) client layer.
  - `app/crypto.js` — Shared SHA-256 commitment, answer normalization, and shadow tag utilities.
  - `app/main.js` & `app/style.css` — Interactive UI controller and styling.
- `tools/` — Build, test, and dev server scripts (`build.mjs`, `test_vm.mjs`, `driver.mjs`, `serve.mjs`).

---

## Quick Start

```bash
# Rebuild all WASM artifacts from Rust source
npm run build:wasm

# Run the Dusk Connect + simulated node test suite
npm test

# Run the DuskVM contract & anti-front-running test suite
npm run test:vm

# Start the local web app (http://localhost:4173)
npm run dev
```
