use minisign_verify::{PublicKey, Signature};
use std::env;
use std::fs::File;
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
    let public_key = PublicKey::from_base64(public_key)?;
    let signature = Signature::from_file(signature_path)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    #[test]
    fn accepts_a_known_prehashed_signature_through_streaming_verification() {
        let public_key = PublicKey::from_base64(PUBLIC_KEY).unwrap();
        let signature = Signature::decode(PREHASHED_SIGNATURE).unwrap();
        let mut verifier = public_key.verify_stream(&signature).unwrap();
        verifier.update(b"te");
        verifier.update(b"st");
        verifier.finalize().unwrap();
    }

    #[test]
    fn refuses_a_signature_for_different_bytes() {
        let public_key = PublicKey::from_base64(PUBLIC_KEY).unwrap();
        let signature = Signature::decode(PREHASHED_SIGNATURE).unwrap();
        assert!(public_key
            .verify(&b"changed"[..], &signature, false)
            .is_err());
    }
}
