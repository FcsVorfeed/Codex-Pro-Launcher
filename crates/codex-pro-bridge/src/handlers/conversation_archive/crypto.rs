use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
};
use anyhow::{Context, bail};
use base64::Engine;
use pbkdf2::pbkdf2_hmac_array;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// 这一段定义会话归档正文加密版本。
/// Conversation archive body-encryption version.
pub const ENCRYPTION_VERSION: u64 = 1;
/// 这一段定义会话归档正文加密算法。
/// Conversation archive body-encryption algorithm.
pub const ENCRYPTION_ALGORITHM: &str = "AES-256-GCM";
/// 这一段定义同步密钥派生版本。
/// Sync-key derivation version.
pub const KEY_DERIVATION_VERSION: u64 = 1;
/// 这一段定义 PBKDF2 迭代次数。
/// PBKDF2 iteration count.
const KEY_DERIVATION_ITERATIONS: u32 = 210_000;
/// 这一段定义 PBKDF2 固定盐。
/// Fixed PBKDF2 salt.
const KEY_DERIVATION_SALT: &[u8] = b"Codex-Pro conversation archive encryption v1";
/// 这一段定义 AEAD AAD 前缀。
/// AEAD AAD prefix.
const PACKAGE_AAD_PREFIX: &str = "Codex-Pro conversation archive package v1";
/// 这一段定义 worker 内同步密钥派生缓存上限。
/// Maximum in-worker sync-key derivation cache entries.
const ARCHIVE_CRYPTO_CACHE_MAX_ENTRIES: usize = 8;

/// 这一段描述包体加密元数据。
/// Describes package-body encryption metadata.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PackageEncryption {
    /// 这一段是加密算法。
    /// Encryption algorithm.
    pub algorithm: String,
    /// 这一段是加密版本。
    /// Encryption version.
    #[serde(rename = "encryptionVersion")]
    pub encryption_version: u64,
    /// 这一段是密钥派生版本。
    /// Key derivation version.
    #[serde(rename = "keyDerivationVersion")]
    pub key_derivation_version: u64,
    /// 这一段是密钥派生迭代次数。
    /// Key derivation iteration count.
    #[serde(rename = "keyDerivationIterations")]
    pub key_derivation_iterations: u32,
    /// 这一段是 nonce 的 base64 表示。
    /// Base64 nonce.
    #[serde(rename = "nonceBase64")]
    pub nonce_base64: String,
}

/// 这一段描述加密后的包体。
/// Describes an encrypted package body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncryptedPackage {
    /// 这一段是密文字节。
    /// Ciphertext bytes.
    pub ciphertext: Vec<u8>,
    /// 这一段是密文 SHA-256。
    /// Ciphertext SHA-256.
    pub encrypted_sha256: String,
    /// 这一段是加密元数据。
    /// Encryption metadata.
    pub encryption: PackageEncryption,
}

/// 这一段保存一次请求内复用的派生密钥。
/// Stores derived keys reused during one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveCrypto {
    /// 这一段是正文加密密钥。
    /// Content-encryption key.
    content_key: [u8; 32],
    /// 这一段是旧明文同步域哈希。
    /// Legacy plaintext sync-domain hash.
    legacy_sync_key_hash: String,
    /// 这一段是发送给服务端的同步域定位密钥。
    /// Server-facing sync-domain lookup key.
    remote_sync_key: String,
}

impl ArchiveCrypto {
    /// 这一段从用户同步密钥派生远端定位密钥和正文加密密钥。
    /// Derive the remote lookup key and content key from the user sync key.
    pub fn derive(sync_key: &str) -> anyhow::Result<Self> {
        // 这一段拒绝空字节和过短密钥，和请求 parser 的安全边界保持一致。
        // Reject NUL bytes and short keys, matching the request parser boundary.
        let sync_key = sync_key.trim();
        if sync_key.len() < 16 || sync_key.contains('\0') {
            bail!("invalid conversation archive sync key");
        }
        let legacy_sync_key_hash = sha256_hex(sync_key.as_bytes());
        let cache_key = archive_crypto_cache_key(&legacy_sync_key_hash);
        if let Some(cached) = read_archive_crypto_cache(&cache_key) {
            return Ok(cached);
        }

        // 这一段一次性派生 64 字节：前 32 字节加密正文，后 32 字节生成远端定位密钥。
        // Derive 64 bytes once: first 32 for content encryption, next 32 for remote lookup.
        let derived = pbkdf2_hmac_array::<Sha256, 64>(
            sync_key.as_bytes(),
            KEY_DERIVATION_SALT,
            KEY_DERIVATION_ITERATIONS,
        );
        let content_key = derived[..32]
            .try_into()
            .context("invalid derived content key length")?;
        let lookup_seed = &derived[32..64];
        let remote_sync_key = format!("cpae1_{}", sha256_hex(lookup_seed));

        let archive_crypto = Self {
            content_key,
            legacy_sync_key_hash,
            remote_sync_key,
        };
        write_archive_crypto_cache(cache_key, archive_crypto.clone());
        Ok(archive_crypto)
    }

    /// 这一段返回旧明文同步域哈希。
    /// Return the legacy plaintext sync-domain hash.
    pub fn legacy_sync_key_hash(&self) -> &str {
        &self.legacy_sync_key_hash
    }

    /// 这一段返回服务端同步域定位密钥。
    /// Return the server-facing sync-domain lookup key.
    pub fn remote_sync_key(&self) -> &str {
        &self.remote_sync_key
    }

    /// 这一段加密压缩后的会话包字节。
    /// Encrypt compressed thread-package bytes.
    pub fn encrypt_package(
        &self,
        compressed: &[u8],
        archive_path: &str,
        package_sha256: &str,
    ) -> anyhow::Result<EncryptedPackage> {
        // 这一段用随机 nonce 加密，并把路径和明文包 hash 绑定进 AAD。
        // Encrypt with a random nonce and bind the path plus plaintext package hash as AAD.
        let cipher = Aes256Gcm::new_from_slice(&self.content_key)
            .context("failed to initialize conversation archive cipher")?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let aad = package_aad(archive_path, package_sha256);
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: compressed,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| anyhow::anyhow!("conversation archive package encryption failed"))?;
        let encrypted_sha256 = sha256_hex(&ciphertext);
        Ok(EncryptedPackage {
            ciphertext,
            encrypted_sha256,
            encryption: PackageEncryption {
                algorithm: ENCRYPTION_ALGORITHM.to_string(),
                encryption_version: ENCRYPTION_VERSION,
                key_derivation_iterations: KEY_DERIVATION_ITERATIONS,
                key_derivation_version: KEY_DERIVATION_VERSION,
                nonce_base64: base64::engine::general_purpose::STANDARD.encode(nonce.as_slice()),
            },
        })
    }

    /// 这一段解密远端密文会话包字节。
    /// Decrypt remote encrypted thread-package bytes.
    pub fn decrypt_package(
        &self,
        ciphertext: &[u8],
        encryption: &PackageEncryption,
        archive_path: &str,
        package_sha256: &str,
    ) -> anyhow::Result<Vec<u8>> {
        // 这一段先校验加密协议版本，避免把旧明文包当密文解读。
        // Validate the encryption protocol first so legacy plaintext packages are not treated as ciphertext.
        if encryption.algorithm != ENCRYPTION_ALGORITHM
            || encryption.encryption_version != ENCRYPTION_VERSION
            || encryption.key_derivation_version != KEY_DERIVATION_VERSION
        {
            bail!("unsupported conversation archive encryption format");
        }
        let nonce_bytes = base64::engine::general_purpose::STANDARD
            .decode(encryption.nonce_base64.as_bytes())
            .context("invalid conversation archive package nonce")?;
        if nonce_bytes.len() != 12 {
            bail!("invalid conversation archive package nonce length");
        }
        let cipher = Aes256Gcm::new_from_slice(&self.content_key)
            .context("failed to initialize conversation archive cipher")?;
        let aad = package_aad(archive_path, package_sha256);
        cipher
            .decrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| {
                anyhow::anyhow!(
                    "会话归档包解密失败，请确认同步密钥一致 / Failed to decrypt archive package; check the sync key"
                )
            })
    }
}

/// 这一段返回全局派生密钥缓存。
/// Return the global derived-key cache.
fn archive_crypto_cache() -> &'static Mutex<HashMap<String, ArchiveCrypto>> {
    // 这一段只在 worker 进程内存活，不落盘、不跨进程共享。
    // This lives only in the worker process and is never persisted or shared across processes.
    static CACHE: OnceLock<Mutex<HashMap<String, ArchiveCrypto>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 这一段构造不含明文同步密钥的缓存键。
/// Build a cache key that does not contain the plaintext sync key.
fn archive_crypto_cache_key(legacy_sync_key_hash: &str) -> String {
    // 这一段把派生参数纳入 key，避免未来协议参数变化时复用旧缓存。
    // Include derivation parameters so future protocol changes cannot reuse stale cache entries.
    format!("{KEY_DERIVATION_VERSION}:{KEY_DERIVATION_ITERATIONS}:{legacy_sync_key_hash}")
}

/// 这一段读取 worker 内派生密钥缓存。
/// Read the in-worker derived-key cache.
fn read_archive_crypto_cache(cache_key: &str) -> Option<ArchiveCrypto> {
    // 这一段遇到测试 panic 导致的 poison 时仍取回缓存，不让诊断路径失败。
    // Recover from mutex poisoning after test panics so diagnostics do not fail because of the cache.
    let cache = archive_crypto_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.get(cache_key).cloned()
}

/// 这一段写入 worker 内派生密钥缓存。
/// Write the in-worker derived-key cache.
fn write_archive_crypto_cache(cache_key: String, archive_crypto: ArchiveCrypto) {
    // 这一段限制缓存规模，防止很多不同同步密钥在同一 worker 里无界累积。
    // Bound cache growth so many different sync keys cannot accumulate unboundedly in one worker.
    let mut cache = archive_crypto_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !cache.contains_key(&cache_key) && cache.len() >= ARCHIVE_CRYPTO_CACHE_MAX_ENTRIES {
        cache.clear();
    }
    cache.insert(cache_key, archive_crypto);
}

/// 这一段构造会话包 AAD。
/// Build thread-package AAD.
fn package_aad(archive_path: &str, package_sha256: &str) -> String {
    // 这一段把密文绑定到远端路径和明文包摘要，避免同密钥下跨路径替换。
    // Bind ciphertext to the remote path and plaintext package digest to prevent same-key path swapping.
    format!("{PACKAGE_AAD_PREFIX}\0{archive_path}\0{package_sha256}")
}

/// 这一段计算 SHA-256 十六进制。
/// Compute SHA-256 hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    // 这一段用于派生标识和完整性摘要。
    // Used for derived identifiers and integrity digests.
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段序列化会清理全局缓存的测试。
    /// Serialize tests that clear the global cache.
    fn archive_crypto_cache_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    /// 这一段清理测试内共享派生缓存。
    /// Clear the shared derivation cache inside tests.
    fn clear_archive_crypto_cache_for_tests() {
        let mut cache = archive_crypto_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.clear();
    }

    /// 这一段读取测试内指定派生缓存项。
    /// Read a specific derived-cache entry inside tests.
    fn read_archive_crypto_cache_for_tests(sync_key: &str) -> Option<ArchiveCrypto> {
        let cache = archive_crypto_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_sync_key_hash = sha256_hex(sync_key.trim().as_bytes());
        cache
            .get(&archive_crypto_cache_key(&legacy_sync_key_hash))
            .cloned()
    }

    /// 这一段确认同一个同步密钥会复用 worker 内派生缓存。
    /// Confirm the same sync key reuses the in-worker derivation cache.
    #[test]
    fn derivation_reuses_worker_cache_for_same_key() {
        let _guard = archive_crypto_cache_test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_archive_crypto_cache_for_tests();
        let sync_key = "test-sync-key-1234567890";
        let first = ArchiveCrypto::derive(sync_key).unwrap();
        let second = ArchiveCrypto::derive(sync_key).unwrap();

        assert_eq!(first, second);
        assert_eq!(read_archive_crypto_cache_for_tests(sync_key), Some(first));
    }

    /// 这一段确认不同同步密钥不会命中同一个派生缓存。
    /// Confirm different sync keys do not share one derived-cache entry.
    #[test]
    fn derivation_cache_separates_different_keys() {
        let _guard = archive_crypto_cache_test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_archive_crypto_cache_for_tests();
        let first_key = "test-sync-key-1234567890";
        let second_key = "other-sync-key-1234567890";
        let first = ArchiveCrypto::derive(first_key).unwrap();
        let second = ArchiveCrypto::derive(second_key).unwrap();

        assert_ne!(first.remote_sync_key(), second.remote_sync_key());
        assert_eq!(read_archive_crypto_cache_for_tests(first_key), Some(first));
        assert_eq!(
            read_archive_crypto_cache_for_tests(second_key),
            Some(second)
        );
    }

    /// 这一段确认同一明文多次加密会生成不同密文。
    /// Confirm the same plaintext encrypts to different ciphertexts.
    #[test]
    fn encryption_uses_random_nonce() {
        let crypto = ArchiveCrypto::derive("test-sync-key-1234567890").unwrap();
        let first = crypto
            .encrypt_package(b"compressed package", "devices/device_a/profiles/profile_a/conversations/conversation_default/threads/2026/06/thread/index.md", "a")
            .unwrap();
        let second = crypto
            .encrypt_package(b"compressed package", "devices/device_a/profiles/profile_a/conversations/conversation_default/threads/2026/06/thread/index.md", "a")
            .unwrap();

        assert_ne!(first.ciphertext, second.ciphertext);
        assert_ne!(
            first.encryption.nonce_base64,
            second.encryption.nonce_base64
        );
    }

    /// 这一段确认错误同步密钥不能解密密文。
    /// Confirm a different sync key cannot decrypt ciphertext.
    #[test]
    fn decrypt_rejects_wrong_sync_key() {
        let crypto = ArchiveCrypto::derive("test-sync-key-1234567890").unwrap();
        let other = ArchiveCrypto::derive("other-sync-key-1234567890").unwrap();
        let encrypted = crypto
            .encrypt_package(b"compressed package", "devices/device_a/profiles/profile_a/conversations/conversation_default/threads/2026/06/thread/index.md", "a")
            .unwrap();

        assert!(
            other
                .decrypt_package(
                    &encrypted.ciphertext,
                    &encrypted.encryption,
                    "devices/device_a/profiles/profile_a/conversations/conversation_default/threads/2026/06/thread/index.md",
                    "a",
                )
                .is_err()
        );
    }
}
