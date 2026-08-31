use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::env;
use std::fs::{read_to_string, File};
use std::io::Read;
use std::path::Path;

fn main() {
    if let Err(error) = run() {
        eprintln!("release signature verification failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.len() != 3 {
        return Err("expected installer path, signature path, and updater public key".into());
    }
    verify_file(
        Path::new(&arguments[0]),
        Path::new(&arguments[1]),
        &arguments[2],
    )
}

fn verify_file(
    artifact: &Path,
    signature_path: &Path,
    public_key: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let public_key = decode_tauri_public_key(public_key)?;
    let signature = decode_tauri_signature(&read_to_string(signature_path)?)?;
    let mut verifier = public_key.verify_stream(&signature)?;
    let mut artifact = File::open(artifact)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes_read = artifact.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        verifier.update(&buffer[..bytes_read]);
    }
    verifier.finalize()?;
    Ok(())
}

fn decode_tauri_public_key(encoded: &str) -> Result<PublicKey, Box<dyn std::error::Error>> {
    let decoded = decode_tauri_text("updater public key", encoded)?;
    Ok(PublicKey::decode(&decoded)?)
}

fn decode_tauri_signature(encoded: &str) -> Result<Signature, Box<dyn std::error::Error>> {
    let decoded = decode_tauri_text("updater signature", encoded)?;
    Ok(Signature::decode(&decoded)?)
}

fn decode_tauri_text(label: &str, encoded: &str) -> Result<String, Box<dyn std::error::Error>> {
    let bytes = STANDARD
        .decode(encoded.trim())
        .map_err(|_| format!("{label} is not valid Tauri base64"))?;
    String::from_utf8(bytes).map_err(|_| format!("{label} is not UTF-8 minisign data").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    #[test]
    fn accepts_tauri_wrapped_key_and_signature_through_streaming_verification() {
        let public_key = decode_tauri_public_key(&tauri_public_key()).unwrap();
        let signature = decode_tauri_signature(&STANDARD.encode(PREHASHED_SIGNATURE)).unwrap();
        let mut verifier = public_key.verify_stream(&signature).unwrap();
        verifier.update(b"te");
        verifier.update(b"st");
        verifier.finalize().unwrap();
    }

    #[test]
    fn refuses_a_signature_for_different_bytes() {
        let public_key = decode_tauri_public_key(&tauri_public_key()).unwrap();
        let signature = decode_tauri_signature(&STANDARD.encode(PREHASHED_SIGNATURE)).unwrap();
        assert!(public_key
            .verify(&b"changed"[..], &signature, false)
            .is_err());
    }

    #[test]
    fn refuses_unwrapped_minisign_text_at_the_tauri_wire_boundary() {
        assert!(decode_tauri_public_key(PUBLIC_KEY).is_err());
        assert!(decode_tauri_signature(PREHASHED_SIGNATURE).is_err());
    }

    fn tauri_public_key() -> String {
        STANDARD.encode(format!(
            "untrusted comment: minisign public key fixture\n{PUBLIC_KEY}\n"
        ))
    }
}
