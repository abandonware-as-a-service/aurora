#![no_std]

extern crate alloc;

use alloc::string::String;
use bytecheck::CheckBytes;
use dusk_core::signatures::bls::PublicKey as BlsPublicKey;
use dusk_forge::ContractEvent;
use rkyv::{Archive, Deserialize, Serialize};

/// A new Aurora puzzle vault was locked on-chain with a Moonlight DUSK bounty.
#[derive(Archive, Serialize, Deserialize)]
#[archive_attr(derive(CheckBytes))]
#[cfg_attr(feature = "data-driver", derive(serde::Serialize, serde::Deserialize))]
pub struct VaultCreated {
    pub id: u64,
    pub creator: BlsPublicKey,
    pub title: String,
    pub category: String,
    pub bounty: u64,
    pub attempt_fee: u64,
    pub expires_at: u64,
}

impl ContractEvent for VaultCreated {
    const TOPICS: &'static [&'static str] = &["vault_created"];
}

/// Additional DUSK bounty was added to an open vault.
#[derive(Archive, Serialize, Deserialize)]
#[archive_attr(derive(CheckBytes))]
#[cfg_attr(feature = "data-driver", derive(serde::Serialize, serde::Deserialize))]
pub struct VaultFunded {
    pub id: u64,
    pub funder: BlsPublicKey,
    pub added: u64,
    pub total_bounty: u64,
}

impl ContractEvent for VaultFunded {
    const TOPICS: &'static [&'static str] = &["vault_funded"];
}

/// A solver locked in a blinded commitment hash for a vault (paying `attempt_fee` if configured).
#[derive(Archive, Serialize, Deserialize)]
#[archive_attr(derive(CheckBytes))]
#[cfg_attr(feature = "data-driver", derive(serde::Serialize, serde::Deserialize))]
pub struct SolutionCommitted {
    pub vault_id: u64,
    pub solver: BlsPublicKey,
    pub attempt_fee_paid: u64,
    pub committed_at: u64,
}

impl ContractEvent for SolutionCommitted {
    const TOPICS: &'static [&'static str] = &["committed"];
}

/// A solver revealed the correct solution and cracked the vault.
/// If the solver chose to remain anonymous, `winner` is `None` and `display_name`
/// holds their deterministic pseudonymous shadow tag.
#[derive(Archive, Serialize, Deserialize)]
#[archive_attr(derive(CheckBytes))]
#[cfg_attr(feature = "data-driver", derive(serde::Serialize, serde::Deserialize))]
pub struct VaultCracked {
    pub id: u64,
    pub bounty: u64,
    pub creator_fee_earned: u64,
    pub winning_answer: String,
    pub winner: Option<BlsPublicKey>,
    pub display_name: String,
    pub disclosed: bool,
}

impl ContractEvent for VaultCracked {
    const TOPICS: &'static [&'static str] = &["vault_cracked"];
}

/// An expired, unsolved vault's bounty was reclaimed by its creator (and solver attempt fees refunded).
#[derive(Archive, Serialize, Deserialize)]
#[archive_attr(derive(CheckBytes))]
#[cfg_attr(feature = "data-driver", derive(serde::Serialize, serde::Deserialize))]
pub struct VaultReclaimed {
    pub id: u64,
    pub creator: BlsPublicKey,
    pub refunded: u64,
    pub solver_fees_refunded: u64,
}

impl ContractEvent for VaultReclaimed {
    const TOPICS: &'static [&'static str] = &["vault_reclaimed"];
}

/// The creator published a new hint for an open vault.
#[derive(Archive, Serialize, Deserialize)]
#[archive_attr(derive(CheckBytes))]
#[cfg_attr(feature = "data-driver", derive(serde::Serialize, serde::Deserialize))]
pub struct HintAdded {
    pub id: u64,
    pub hint: String,
}

impl ContractEvent for HintAdded {
    const TOPICS: &'static [&'static str] = &["hint_added"];
}

#[dusk_forge::contract(events = [
    crate::VaultCreated,
    crate::VaultFunded,
    crate::SolutionCommitted,
    crate::VaultCracked,
    crate::VaultReclaimed,
    crate::HintAdded
])]
mod aurora {
    use alloc::string::String;
    use alloc::vec::Vec;
    use dusk_bytes::Serializable;
    use dusk_core::abi;
    use dusk_core::signatures::bls::PublicKey as BlsPublicKey;
    use dusk_core::transfer::{ContractToAccount, TRANSFER_CONTRACT};

    const STATUS_OPEN: u8 = 0;
    const STATUS_CRACKED: u8 = 1;
    const STATUS_RECLAIMED: u8 = 2;

    // A reveal must happen at least 1 block after its commitment so a mempool
    // observer who sees the plaintext reveal cannot commit and reveal in the same block.
    const MIN_REVEAL_DELAY: u64 = 1;
    // Commitments stay valid for 120 blocks before they can be replaced or re-submitted.
    const COMMIT_WINDOW: u64 = 120;
    // Grace window after `expires_at` allowing a solver who committed before expiry
    // to complete their reveal without being front-run by `reclaim_expired`.
    const REVEAL_GRACE_BLOCKS: u64 = 5;
    // Every vault must have a finite expiry block so locked bounties and attempt fees
    // can never be permanently stuck if a riddle goes unsolved.
    const DEFAULT_DURATION_BLOCKS: u64 = 200;

    const ANSWER_DOMAIN: &[u8] = b"aurora:answer:v1:";
    const COMMIT_DOMAIN: &[u8] = b"aurora:commit:v1:";
    const SHADOW_DOMAIN: &[u8] = b"aurora:shadow:v1:";

    struct Vault {
        title: String,
        lore: String,
        category: String,
        hint: String,
        answer_hash: [u8; 32],
        creator: BlsPublicKey,
        bounty: u64,
        attempt_fee: u64,
        creator_fee_pool: u64,
        solver_jackpot_added: u64,
        created_at: u64,
        expires_at: u64,
        status: u8,
        solver: Option<BlsPublicKey>,
        disclosed: bool,
        winner_label: String,
        winning_answer: String,
        cracked_at: u64,
        attempts: u64,
    }

    struct Commitment {
        vault_id: u64,
        solver: BlsPublicKey,
        hash: [u8; 32],
        committed_at: u64,
        fees_paid: u64,
    }

    struct SolverProfile {
        solver: BlsPublicKey,
        shadow_tag: String,
        alias: String,
        disclosed: bool,
        cracks: u64,
        bounty_won: u64,
        last_crack_at: u64,
    }

    pub struct Aurora {
        vaults: Vec<Vault>,
        commitments: Vec<Commitment>,
        solvers: Vec<SolverProfile>,
        total_locked: u64,
        total_paid: u64,
        total_cracked: u64,
        total_creator_fees_paid: u64,
    }

    impl Aurora {
        pub const fn new() -> Self {
            Self {
                vaults: Vec::new(),
                commitments: Vec::new(),
                solvers: Vec::new(),
                total_locked: 0,
                total_paid: 0,
                total_cracked: 0,
                total_creator_fees_paid: 0,
            }
        }

        fn require_moonlight() -> BlsPublicKey {
            abi::public_sender().expect("Use a public Moonlight account")
        }

        fn normalize_answer(raw: &str) -> Vec<u8> {
            raw.trim()
                .bytes()
                .map(|b| if b.is_ascii_uppercase() { b + 32 } else { b })
                .collect()
        }

        fn hash_answer(answer: &str) -> [u8; 32] {
            let norm = Self::normalize_answer(answer);
            let mut preimage = Vec::with_capacity(ANSWER_DOMAIN.len() + norm.len());
            preimage.extend_from_slice(ANSWER_DOMAIN);
            preimage.extend_from_slice(&norm);
            abi::sha256(preimage)
        }

        fn hash_commitment(
            vault_id: u64,
            solver: &BlsPublicKey,
            answer_hash: &[u8; 32],
            salt: &str,
        ) -> [u8; 32] {
            let salt_bytes = salt.trim().as_bytes();
            let solver_bytes = solver.to_bytes();
            let mut preimage = Vec::with_capacity(
                COMMIT_DOMAIN.len() + 8 + solver_bytes.len() + 32 + salt_bytes.len(),
            );
            preimage.extend_from_slice(COMMIT_DOMAIN);
            preimage.extend_from_slice(&vault_id.to_le_bytes());
            preimage.extend_from_slice(&solver_bytes);
            preimage.extend_from_slice(answer_hash);
            preimage.extend_from_slice(salt_bytes);
            abi::sha256(preimage)
        }

        fn make_shadow_tag(solver: &BlsPublicKey) -> String {
            const HEX: &[u8; 16] = b"0123456789abcdef";
            let solver_bytes = solver.to_bytes();
            let mut preimage = Vec::with_capacity(SHADOW_DOMAIN.len() + solver_bytes.len());
            preimage.extend_from_slice(SHADOW_DOMAIN);
            preimage.extend_from_slice(&solver_bytes);
            let digest = abi::sha256(preimage);
            let mut out = String::from("Shadow #");
            for b in &digest[..3] {
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0x0f) as usize] as char);
            }
            out
        }

        fn validate_alias(alias: &str) -> &str {
            let trimmed = alias.trim();
            assert!(trimmed.len() <= 32, "Keep your alias under 32 bytes");
            assert!(
                !trimmed.bytes().any(|b| b < 0x20 || b == 0x7f),
                "Alias cannot contain control characters"
            );
            // Prevent spoofing another solver's anonymous "Shadow #xxxxxx" tag
            let lower_prefix: Vec<u8> = trimmed
                .bytes()
                .take(8)
                .map(|b| if b.is_ascii_uppercase() { b + 32 } else { b })
                .collect();
            assert!(
                !lower_prefix.starts_with(b"shadow #") && !lower_prefix.starts_with(b"shadow#"),
                "Aliases cannot impersonate anonymous Shadow tags"
            );
            trimmed
        }

        fn clean_alias(alias: &str, shadow_tag: &str, disclosed: bool) -> String {
            let trimmed = Self::validate_alias(alias);
            if !disclosed {
                return String::from(shadow_tag);
            }
            if trimmed.is_empty() {
                String::from("Disclosed Keeper")
            } else {
                String::from(trimmed)
            }
        }

        pub fn create_vault(
            &mut self,
            title: String,
            lore: String,
            category: String,
            hint: String,
            answer_hash: [u8; 32],
            bounty: u64,
            attempt_fee: u64,
            duration_blocks: u64,
        ) -> u64 {
            let creator = Self::require_moonlight();
            let clean_title = title.trim();
            let clean_lore = lore.trim();
            assert!(!clean_title.is_empty(), "Give the vault a title");
            assert!(clean_title.len() <= 80, "Keep the title under 80 bytes");
            assert!(!clean_lore.is_empty(), "Give the vault a riddle or challenge prompt");
            assert!(clean_lore.len() <= 600, "Keep the challenge prompt under 600 bytes");
            assert!(hint.len() <= 240, "Keep the hint under 240 bytes");
            assert!(answer_hash != [0u8; 32], "Supply a non-zero SHA-256 answer hash");
            assert!(
                attempt_fee <= bounty / 2,
                "Attempt fee cannot exceed 50% of the initial vault bounty"
            );

            let cat = if category.trim().is_empty() {
                String::from("Riddle")
            } else {
                String::from(category.trim())
            };
            assert!(cat.len() <= 32, "Keep the category under 32 bytes");

            if bounty > 0 {
                abi::call::<_, ()>(TRANSFER_CONTRACT, "deposit", &bounty)
                    .expect("DUSK deposit to Aurora failed");
                self.total_locked += bounty;
            }

            let now = abi::block_height();
            let effective_duration = if duration_blocks == 0 {
                DEFAULT_DURATION_BLOCKS
            } else {
                duration_blocks
            };
            let expires_at = now + effective_duration;
            let id = self.vaults.len() as u64;

            self.vaults.push(Vault {
                title: String::from(clean_title),
                lore: String::from(clean_lore),
                category: cat.clone(),
                hint: String::from(hint.trim()),
                answer_hash,
                creator,
                bounty,
                attempt_fee,
                creator_fee_pool: 0,
                solver_jackpot_added: 0,
                created_at: now,
                expires_at,
                status: STATUS_OPEN,
                solver: None,
                disclosed: false,
                winner_label: String::new(),
                winning_answer: String::new(),
                cracked_at: 0,
                attempts: 0,
            });

            abi::emit(
                "vault_created",
                crate::VaultCreated {
                    id,
                    creator,
                    title: String::from(clean_title),
                    category: cat,
                    bounty,
                    attempt_fee,
                    expires_at,
                },
            );
            id
        }

        pub fn fund_vault(&mut self, id: u64, amount: u64) {
            let funder = Self::require_moonlight();
            assert!(amount > 0, "Fund with a positive DUSK amount");
            let now = abi::block_height();
            let vault = self.vaults.get_mut(id as usize).expect("No such Aurora vault");
            assert!(vault.status == STATUS_OPEN, "This vault is no longer open");
            assert!(
                vault.expires_at == 0 || now < vault.expires_at,
                "This vault has already expired"
            );

            abi::call::<_, ()>(TRANSFER_CONTRACT, "deposit", &amount)
                .expect("DUSK deposit to Aurora failed");

            vault.bounty += amount;
            self.total_locked += amount;
            let total_bounty = vault.bounty;

            abi::emit(
                "vault_funded",
                crate::VaultFunded {
                    id,
                    funder,
                    added: amount,
                    total_bounty,
                },
            );
        }

        pub fn add_hint(&mut self, id: u64, hint: String) {
            let caller = Self::require_moonlight();
            let clean = hint.trim();
            assert!(!clean.is_empty(), "Provide a non-empty hint");
            assert!(clean.len() <= 240, "Keep the hint under 240 bytes");
            let vault = self.vaults.get_mut(id as usize).expect("No such Aurora vault");
            assert!(vault.creator == caller, "Only the vault creator can update its hint");
            assert!(vault.status == STATUS_OPEN, "This vault is no longer open");

            vault.hint = String::from(clean);
            abi::emit(
                "hint_added",
                crate::HintAdded {
                    id,
                    hint: String::from(clean),
                },
            );
        }

        pub fn commit_solution(&mut self, vault_id: u64, commitment: [u8; 32]) {
            let solver = Self::require_moonlight();
            assert!(commitment != [0u8; 32], "Commitment hash cannot be all zeros");
            let now = abi::block_height();
            let vault = self
                .vaults
                .get_mut(vault_id as usize)
                .expect("No such Aurora vault");
            assert!(vault.status == STATUS_OPEN, "This vault is no longer open");
            assert!(
                vault.expires_at == 0 || now < vault.expires_at,
                "This vault has expired"
            );
            assert!(
                solver != vault.creator,
                "Vault creators cannot submit solution commitments to their own vault"
            );

            let fee = vault.attempt_fee;
            if fee > 0 {
                abi::call::<_, ()>(TRANSFER_CONTRACT, "deposit", &fee)
                    .expect("Attempt fee deposit to Aurora failed");
                // 20% of each attempt fee grows the solver jackpot bounty;
                // 80% enters the creator's escrowed fee pool (unlocked only when the vault is cracked).
                let jackpot_cut = fee / 5;
                let creator_cut = fee - jackpot_cut;
                vault.bounty += jackpot_cut;
                vault.solver_jackpot_added += jackpot_cut;
                vault.creator_fee_pool += creator_cut;
                self.total_locked += fee;
            }

            vault.attempts += 1;

            if let Some(existing) = self
                .commitments
                .iter_mut()
                .find(|c| c.vault_id == vault_id && c.solver == solver)
            {
                existing.hash = commitment;
                existing.committed_at = now;
                existing.fees_paid += fee;
            } else {
                self.commitments.push(Commitment {
                    vault_id,
                    solver,
                    hash: commitment,
                    committed_at: now,
                    fees_paid: fee,
                });
            }

            abi::emit(
                "committed",
                crate::SolutionCommitted {
                    vault_id,
                    solver,
                    attempt_fee_paid: fee,
                    committed_at: now,
                },
            );
        }

        pub fn reveal_solution(
            &mut self,
            vault_id: u64,
            answer: String,
            salt: String,
            disclose_winner: bool,
            alias: String,
        ) {
            let solver = Self::require_moonlight();
            assert!(
                !answer.trim().is_empty() && answer.len() <= 256,
                "Answer must be between 1 and 256 bytes"
            );
            assert!(
                !salt.trim().is_empty() && salt.len() <= 128,
                "Salt must be between 1 and 128 bytes"
            );
            let clean_alias_str = Self::validate_alias(&alias);
            let now = abi::block_height();

            let (commit_hash, committed_at) = self
                .commitments
                .iter()
                .find(|c| c.vault_id == vault_id && c.solver == solver)
                .map(|c| (c.hash, c.committed_at))
                .expect("Commit a blinded solution hash before revealing");

            assert!(
                now >= committed_at + MIN_REVEAL_DELAY,
                "Wait at least 1 block after committing before revealing"
            );
            assert!(
                now <= committed_at + COMMIT_WINDOW,
                "Commitment window expired; submit a fresh commitment"
            );

            let candidate_hash = Self::hash_answer(&answer);
            let expected_commit =
                Self::hash_commitment(vault_id, &solver, &candidate_hash, &salt);
            assert!(
                expected_commit == commit_hash,
                "Commitment hash does not match this answer, salt, and account"
            );

            let shadow_tag = Self::make_shadow_tag(&solver);
            let label = Self::clean_alias(clean_alias_str, &shadow_tag, disclose_winner);
            let normalized_ans_str =
                String::from_utf8(Self::normalize_answer(&answer)).unwrap_or_default();

            let vault = self
                .vaults
                .get_mut(vault_id as usize)
                .expect("No such Aurora vault");
            assert!(vault.status == STATUS_OPEN, "This vault is no longer open");
            assert!(
                vault.expires_at == 0
                    || (committed_at < vault.expires_at
                        && now <= vault.expires_at + REVEAL_GRACE_BLOCKS),
                "This vault has expired"
            );
            assert!(
                candidate_hash == vault.answer_hash,
                "Wrong answer for this Aurora vault"
            );

            let bounty = vault.bounty;
            let creator_fee = vault.creator_fee_pool;
            let creator_account = vault.creator;
            vault.status = STATUS_CRACKED;
            vault.solver = Some(solver);
            vault.disclosed = disclose_winner;
            vault.winner_label = label.clone();
            vault.winning_answer = normalized_ans_str.clone();
            vault.cracked_at = now;
            self.total_cracked += 1;

            // Prune commitments for this solved vault before external calls
            self.commitments.retain(|c| c.vault_id != vault_id);

            if bounty > 0 {
                self.total_locked -= bounty;
                self.total_paid += bounty;
                let payout = ContractToAccount {
                    account: solver,
                    value: bounty,
                };
                abi::call::<_, ()>(TRANSFER_CONTRACT, "contract_to_account", &payout)
                    .expect("Bounty payout to winner failed");
            }

            if creator_fee > 0 {
                self.total_locked -= creator_fee;
                self.total_creator_fees_paid += creator_fee;
                let creator_payout = ContractToAccount {
                    account: creator_account,
                    value: creator_fee,
                };
                abi::call::<_, ()>(TRANSFER_CONTRACT, "contract_to_account", &creator_payout)
                    .expect("Attempt fee payout to vault creator failed");
            }

            if let Some(profile) = self.solvers.iter_mut().find(|p| p.solver == solver) {
                profile.cracks += 1;
                profile.bounty_won += bounty;
                profile.last_crack_at = now;
                profile.disclosed = disclose_winner;
                if disclose_winner && !clean_alias_str.is_empty() {
                    profile.alias = String::from(clean_alias_str);
                }
            } else {
                self.solvers.push(SolverProfile {
                    solver,
                    shadow_tag,
                    alias: if disclose_winner && !clean_alias_str.is_empty() {
                        String::from(clean_alias_str)
                    } else {
                        String::from("Disclosed Keeper")
                    },
                    disclosed: disclose_winner,
                    cracks: 1,
                    bounty_won: bounty,
                    last_crack_at: now,
                });
            }

            abi::emit(
                "vault_cracked",
                crate::VaultCracked {
                    id: vault_id,
                    bounty,
                    creator_fee_earned: creator_fee,
                    winning_answer: normalized_ans_str,
                    winner: if disclose_winner { Some(solver) } else { None },
                    display_name: label,
                    disclosed: disclose_winner,
                },
            );
        }

        pub fn reclaim_expired(&mut self, id: u64) {
            let _caller = Self::require_moonlight();
            let now = abi::block_height();
            let has_pending_grace_commit = self
                .commitments
                .iter()
                .any(|c| c.vault_id == id && now <= c.committed_at + REVEAL_GRACE_BLOCKS);

            let vault = self.vaults.get_mut(id as usize).expect("No such Aurora vault");
            assert!(vault.status == STATUS_OPEN, "This vault is no longer open");
            assert!(vault.expires_at > 0, "This vault has no expiry block");
            assert!(now >= vault.expires_at, "This vault has not expired yet");
            assert!(
                !has_pending_grace_commit,
                "Wait for active commitment reveal grace window to finish before reclaiming"
            );

            // Creator only reclaims their original/funded bounty (excluding solver attempt fee jackpot rollovers).
            // All solver attempt fees (`creator_fee_pool + solver_jackpot_added`) are refunded back to the solvers!
            // Any Moonlight account (creator or solver) can trigger settlement once expired.
            let creator_account = vault.creator;
            let creator_refund = vault.bounty.saturating_sub(vault.solver_jackpot_added);
            let solver_fee_pool_total = vault.creator_fee_pool + vault.solver_jackpot_added;
            vault.status = STATUS_RECLAIMED;
            vault.bounty = 0;
            vault.creator_fee_pool = 0;
            vault.solver_jackpot_added = 0;

            let mut refunds: Vec<(BlsPublicKey, u64)> = Vec::new();
            for c in &self.commitments {
                if c.vault_id == id && c.fees_paid > 0 {
                    refunds.push((c.solver, c.fees_paid));
                }
            }
            self.commitments.retain(|c| c.vault_id != id);

            if creator_refund > 0 {
                self.total_locked -= creator_refund;
                let transfer = ContractToAccount {
                    account: creator_account,
                    value: creator_refund,
                };
                abi::call::<_, ()>(TRANSFER_CONTRACT, "contract_to_account", &transfer)
                    .expect("Refund transfer to creator failed");
            }

            let mut total_solver_refunded = 0u64;
            for (solver_acc, amt) in refunds {
                self.total_locked -= amt;
                total_solver_refunded += amt;
                let refund_tx = ContractToAccount {
                    account: solver_acc,
                    value: amt,
                };
                abi::call::<_, ()>(TRANSFER_CONTRACT, "contract_to_account", &refund_tx)
                    .expect("Attempt fee refund to solver failed");
            }
            debug_assert_eq!(total_solver_refunded, solver_fee_pool_total);

            abi::emit(
                "vault_reclaimed",
                crate::VaultReclaimed {
                    id,
                    creator: creator_account,
                    refunded: creator_refund,
                    solver_fees_refunded: total_solver_refunded,
                },
            );
        }

        pub fn set_disclosure(&mut self, disclose: bool, alias: String) {
            let caller = Self::require_moonlight();
            let clean_alias_str = Self::validate_alias(&alias);
            let shadow_tag = Self::make_shadow_tag(&caller);
            let profile = self
                .solvers
                .iter_mut()
                .find(|p| p.solver == caller)
                .expect("Crack at least one vault to configure your leaderboard identity");

            profile.disclosed = disclose;
            if !clean_alias_str.is_empty() {
                profile.alias = String::from(clean_alias_str);
            }
            let updated_label = if disclose {
                profile.alias.clone()
            } else {
                shadow_tag
            };

            for vault in &mut self.vaults {
                if vault.solver == Some(caller) {
                    vault.disclosed = disclose;
                    vault.winner_label = updated_label.clone();
                }
            }
        }

        // ---- Read-only Queries (Getters) ----------------------------------------------------------

        pub fn vault_count(&self) -> u64 {
            self.vaults.len() as u64
        }

        pub fn total_bounty_locked(&self) -> u64 {
            self.total_locked
        }

        pub fn total_bounty_paid(&self) -> u64 {
            self.total_paid
        }

        pub fn total_cracked(&self) -> u64 {
            self.total_cracked
        }

        pub fn total_creator_fees_paid(&self) -> u64 {
            self.total_creator_fees_paid
        }

        pub fn vault_bounty(&self, id: u64) -> u64 {
            self.vaults.get(id as usize).map_or(0, |v| v.bounty)
        }

        /// Returns `(attempt_fee, creator_fee_pool, solver_jackpot_added)` for a vault.
        pub fn vault_economics(&self, id: u64) -> Option<(u64, u64, u64)> {
            self.vaults.get(id as usize).map(|v| {
                (v.attempt_fee, v.creator_fee_pool, v.solver_jackpot_added)
            })
        }

        pub fn vault_meta(&self, id: u64) -> Option<(String, String, String, String)> {
            self.vaults.get(id as usize).map(|v| {
                (
                    v.title.clone(),
                    v.lore.clone(),
                    v.category.clone(),
                    v.hint.clone(),
                )
            })
        }

        pub fn vault_state(&self, id: u64) -> Option<(u8, u64, u64, u64, u64, bool)> {
            self.vaults.get(id as usize).map(|v| {
                (
                    v.status,
                    v.created_at,
                    v.expires_at,
                    v.cracked_at,
                    v.attempts,
                    v.disclosed,
                )
            })
        }

        pub fn vault_creator(&self, id: u64) -> Option<BlsPublicKey> {
            self.vaults.get(id as usize).map(|v| v.creator)
        }

        pub fn vault_answer_hash(&self, id: u64) -> Option<[u8; 32]> {
            self.vaults.get(id as usize).map(|v| v.answer_hash)
        }

        /// Returns `(winner_pubkey_or_none, winner_label, winning_answer)` for a cracked vault.
        /// Privacy rule: if `disclosed` is false, the solver's `BlsPublicKey` is withheld (`None`)
        /// and only their pseudonymous shadow tag is returned.
        pub fn vault_winner(&self, id: u64) -> Option<(Option<BlsPublicKey>, String, String)> {
            self.vaults.get(id as usize).and_then(|v| {
                if v.status != STATUS_CRACKED {
                    None
                } else if v.disclosed {
                    Some((v.solver, v.winner_label.clone(), v.winning_answer.clone()))
                } else {
                    Some((None, v.winner_label.clone(), v.winning_answer.clone()))
                }
            })
        }

        pub fn commitment_of(&self, vault_id: u64, solver: BlsPublicKey) -> Option<([u8; 32], u64)> {
            self.commitments
                .iter()
                .find(|c| c.vault_id == vault_id && c.solver == solver)
                .map(|c| (c.hash, c.committed_at))
        }

        pub fn solver_count(&self) -> u64 {
            self.solvers.len() as u64
        }

        pub fn solver_bounty_won(&self, index: u64) -> u64 {
            self.solvers.get(index as usize).map_or(0, |s| s.bounty_won)
        }

        /// Leaderboard entry at `index`.
        /// If the solver opted into disclosure, returns `(Some(pk), alias, cracks, last_crack_at, true)`.
        /// Otherwise returns `(None, shadow_tag, cracks, last_crack_at, false)`.
        pub fn solver_entry(
            &self,
            index: u64,
        ) -> Option<(Option<BlsPublicKey>, String, u64, u64, bool)> {
            self.solvers.get(index as usize).map(|s| {
                if s.disclosed {
                    (Some(s.solver), s.alias.clone(), s.cracks, s.last_crack_at, true)
                } else {
                    (None, s.shadow_tag.clone(), s.cracks, s.last_crack_at, false)
                }
            })
        }

        pub fn compute_answer_hash(&self, answer: String) -> [u8; 32] {
            Self::hash_answer(&answer)
        }

        pub fn compute_commitment(
            &self,
            vault_id: u64,
            solver: BlsPublicKey,
            answer_hash: [u8; 32],
            salt: String,
        ) -> [u8; 32] {
            Self::hash_commitment(vault_id, &solver, &answer_hash, &salt)
        }
    }
}
