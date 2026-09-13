package com.versutus.handsfreevoice

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * The signed auto-start contract of §4.4. Any app or web page can fire a
 * `versutus://call` link, so an unsigned link must never open the microphone:
 * only the app's own widget and shortcuts, rendered in-process, can produce a
 * signature. The signing primitives are pure JVM so the round trip, tamper
 * rejection and the 30-day window are unit-tested; only [loadOrCreateKey]
 * touches the Android Keystore.
 */
object HandsfreeLaunchKey {
  const val MAX_AGE_MS: Long = 30L * 24 * 60 * 60 * 1000
  const val ALIAS: String = "versutus.launch"

  /** `call|<botId>|<engine>|<ts>`, the exact bytes that are signed. */
  fun payload(botId: String?, engine: String, ts: Long): String =
    "call|${botId.orEmpty()}|$engine|$ts"

  /** The base64url (no padding) HMAC-SHA256 signature of [payload]. */
  fun sign(key: SecretKey, payload: String): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(signBytes(key, payload))

  /**
   * True only for a signature this key made over [payload], with a timestamp
   * no older than [MAX_AGE_MS]. The compare is constant-time.
   */
  fun verify(key: SecretKey, payload: String, signature: String, ts: Long, now: Long): Boolean {
    if (now - ts > MAX_AGE_MS) return false
    val expected = signBytes(key, payload)
    val provided = try {
      Base64.getUrlDecoder().decode(signature)
    } catch (_: IllegalArgumentException) {
      return false
    }
    if (provided.size != expected.size) return false
    return MessageDigest.isEqual(expected, provided)
  }

  /** Build the link the widget and shortcuts render. */
  fun signedUrl(key: SecretKey, botId: String?, engine: String, ts: Long): String {
    val sig = sign(key, payload(botId, engine, ts))
    val bot = if (botId.isNullOrEmpty()) "" else "bot=$botId&"
    return "versutus://call?${bot}engine=$engine&autoStart=1&ts=$ts&sig=$sig"
  }

  /**
   * Verify a `versutus://call` link end to end: the query must carry
   * `autoStart=1`, a numeric `ts` and a `sig`, and the signature must hold.
   */
  fun verifyFromKey(key: SecretKey, url: String, now: Long): Boolean {
    val parsed = parse(url) ?: return false
    return verify(key, payload(parsed.botId, parsed.engine, parsed.ts), parsed.sig, parsed.ts, now)
  }

  /** The fields a signed call link carries, or null when it is not one. */
  data class Launch(val botId: String?, val engine: String, val ts: Long, val sig: String)

  fun parse(url: String): Launch? {
    if (!url.startsWith("versutus://call")) return null
    val params = url.substringAfter('?', "")
      .split('&')
      .mapNotNull { pair ->
        val at = pair.indexOf('=')
        if (at <= 0) null else pair.substring(0, at) to pair.substring(at + 1)
      }
      .toMap()
    if (params["autoStart"] != "1") return null
    val ts = params["ts"]?.toLongOrNull() ?: return null
    val sig = params["sig"]?.takeIf { it.isNotEmpty() } ?: return null
    val engine = params["engine"]?.takeIf { it.isNotEmpty() } ?: "auto"
    val botId = params["bot"]?.takeIf { it.isNotEmpty() }
    return Launch(botId, engine, ts, sig)
  }

  /** The app's own key, created in the Android Keystore on first use. */
  fun loadOrCreateKey(context: Context): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN).build(),
    )
    return generator.generateKey()
  }

  private fun signBytes(key: SecretKey, payload: String): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(key)
    return mac.doFinal(payload.toByteArray(Charsets.UTF_8))
  }
}
