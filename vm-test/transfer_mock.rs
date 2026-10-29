// Simulated genesis TRANSFER_CONTRACT for DuskVM integration testing.
// Deployed at ContractId [1, 0, ..., 0] (dusk_core::transfer::TRANSFER_CONTRACT).
// Tracks Moonlight account balances and contract deposits/payouts.
#![no_std]

extern crate alloc;

#[dusk_forge::contract]
mod transfer_mock {
    use alloc::vec::Vec;
    use dusk_core::abi;
    use dusk_core::signatures::bls::PublicKey as BlsPublicKey;
    use dusk_core::transfer::ContractToAccount;

    struct AccountEntry {
        key: BlsPublicKey,
        balance: u64,
    }

    pub struct TransferMock {
        accounts: Vec<AccountEntry>,
        contract_pool: u64,
    }

    impl TransferMock {
        pub const fn new() -> Self {
            Self {
                accounts: Vec::new(),
                contract_pool: 0,
            }
        }

        pub fn seed_balance(&mut self, account: BlsPublicKey, amount: u64) {
            if let Some(entry) = self.accounts.iter_mut().find(|a| a.key == account) {
                entry.balance = amount;
            } else {
                self.accounts.push(AccountEntry {
                    key: account,
                    balance: amount,
                });
            }
        }

        pub fn deposit(&mut self, value: u64) {
            let sender = abi::public_sender().expect("Moonlight deposit requires public_sender");
            let entry = self
                .accounts
                .iter_mut()
                .find(|a| a.key == sender)
                .expect("Sender has no Moonlight balance");
            assert!(entry.balance >= value, "Insufficient Moonlight DUSK balance");
            entry.balance -= value;
            self.contract_pool += value;
        }

        pub fn contract_to_account(&mut self, transfer: ContractToAccount) {
            assert!(
                self.contract_pool >= transfer.value,
                "Insufficient contract pool balance"
            );
            self.contract_pool -= transfer.value;
            if let Some(entry) = self.accounts.iter_mut().find(|a| a.key == transfer.account) {
                entry.balance += transfer.value;
            } else {
                self.accounts.push(AccountEntry {
                    key: transfer.account,
                    balance: transfer.value,
                });
            }
        }

        pub fn balance_of(&self, account: BlsPublicKey) -> u64 {
            self.accounts
                .iter()
                .find(|a| a.key == account)
                .map_or(0, |a| a.balance)
        }

        pub fn pool_balance(&self) -> u64 {
            self.contract_pool
        }
    }
}
