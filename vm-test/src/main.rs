use dusk_core::signatures::bls::{PublicKey, SecretKey};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde_json::{Value, json};

const KEEPERS: [(&str, u64); 4] = [("you", 1), ("rook", 2), ("fen", 3), ("wick", 4)];

fn keeper(name: &str) -> PublicKey {
    let (_, seed) = KEEPERS
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap_or_else(|| panic!("unknown keeper {name}"));
    PublicKey::from(&SecretKey::random(&mut ChaCha20Rng::seed_from_u64(*seed)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let mut keys = serde_json::Map::new();
    let mut rkyv_some_sender = serde_json::Map::new();
    for (name, _) in KEEPERS {
        let pk = keeper(name);
        keys.insert(name.to_string(), serde_json::to_value(pk).unwrap());
        let bytes = rkyv::to_bytes::<_, 256>(&Some(pk)).expect("rkyv Option<PublicKey>");
        rkyv_some_sender.insert(name.to_string(), Value::String(hex(&bytes)));
    }
    let none_bytes = rkyv::to_bytes::<_, 256>(&None::<PublicKey>).expect("rkyv None");
    println!(
        "{}",
        json!({
            "keys": keys,
            "rkyv_some": rkyv_some_sender,
            "rkyv_none": hex(&none_bytes),
        })
    );
}
