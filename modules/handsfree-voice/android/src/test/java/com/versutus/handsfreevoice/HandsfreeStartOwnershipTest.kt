package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsfreeStartOwnershipTest {
  @Test
  fun claimingANewerIdSupersedesTheEarlierOwner() {
    val ownership = HandsfreeStartOwnership()
    assertTrue(ownership.claim("a"))
    assertTrue(ownership.owns("a"))
    assertTrue(ownership.claim("b"))
    assertFalse(ownership.owns("a"))
    assertTrue(ownership.owns("b"))
  }

  @Test
  fun claimingTheSameIdKeepsItsOwnAnswer() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("a")
    var answered: String? = null
    assertTrue(ownership.beginPending("a") { answered = it })
    // A retry that reused the id is the same owner, not a new one that should
    // clear the answer it is still waiting on.
    assertFalse(ownership.claim("a"))
    assertTrue(ownership.deliver("a", "started"))
    assertEquals("started", answered)
  }

  // The exact counterexample: an old attempt's cleanup runs after a newer
  // retry has already claimed the native side. It must cancel nothing.
  @Test
  fun aLateCancelOfAnOldAttemptNeverReachesTheNewerRetry() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("old")
    ownership.claim("new")
    assertFalse(ownership.cancel("old"))
    assertTrue(ownership.owns("new"))
    var answered: String? = null
    assertTrue(ownership.beginPending("new") { answered = it })
    assertTrue(ownership.deliver("new", "started"))
    assertEquals("started", answered)
  }

  @Test
  fun aStaleAnswerCannotClearTheNewerAttemptsPendingCallback() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("old")
    var oldAnswered: String? = null
    ownership.beginPending("old") { oldAnswered = it }

    ownership.claim("new")
    // The old service finally boots and reports; it no longer owns the pending
    // slot, so it cannot answer — or clear — the newer attempt.
    assertFalse(ownership.deliver("old", "started"))
    assertEquals(null, oldAnswered)

    var newAnswered: String? = null
    assertTrue(ownership.beginPending("new") { newAnswered = it })
    assertTrue(ownership.deliver("new", "started"))
    assertEquals("started", newAnswered)
  }

  @Test
  fun anAnswerIsDeliveredExactlyOnce() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("a")
    var count = 0
    ownership.beginPending("a") { count += 1 }
    assertTrue(ownership.deliver("a", "started"))
    assertFalse(ownership.deliver("a", "unavailable"))
    assertEquals(1, count)
  }

  @Test
  fun aStaleExpiryCannotInvalidateANewerAttempt() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("old")
    ownership.beginPending("old") { }
    // The retry claims a newer id before the old module timer fires.
    ownership.claim("new")
    assertFalse(ownership.expire("old"))
    assertTrue(ownership.owns("new"))
    var answered: String? = null
    assertTrue(ownership.beginPending("new") { answered = it })
    assertTrue(ownership.deliver("new", "started"))
    assertEquals("started", answered)
  }

  // Bug A: the 4s module timer must invalidate its OWN owner, not only its
  // pending answer, or a queued ACTION_START still passes owns() and opens the
  // microphone for a start JS already reported unavailable.
  @Test
  fun expiryInvalidatesItsOwnOwnerAndItsPendingAnswer() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("a")
    var answered: String? = null
    ownership.beginPending("a") { answered = it }
    assertTrue(ownership.expire("a"))
    assertFalse(ownership.owns("a"))
    assertFalse(ownership.deliver("a", "started"))
    assertEquals(null, answered)
  }

  // Bug B: a module cleanup queues a keyed teardown that re-checks the service
  // owner when it executes. The old cleanup must not end the service a newer
  // retry has already booted.
  @Test
  fun aQueuedOldTeardownCannotEndTheNewerService() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("old")
    ownership.noteServiceStart("old")
    // The newer retry claims and its service comes up before the old queued
    // teardown runs.
    ownership.claim("new")
    ownership.noteServiceStart("new")
    assertFalse(ownership.servesService("old"))
    assertTrue(ownership.servesService("new"))
  }

  @Test
  fun aKeyedTeardownStillRunsWhileItsOwnServiceOwnsTheCall() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("old")
    ownership.noteServiceStart("old")
    assertTrue(ownership.servesService("old"))
    assertEquals("old", ownership.currentService())
    ownership.clearService()
    assertFalse(ownership.servesService("old"))
    assertEquals(null, ownership.currentService())
  }

  @Test
  fun beginPendingRefusesAnIdThatNoLongerOwnsTheStart() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("old")
    ownership.claim("new")
    assertFalse(ownership.beginPending("old") { })
    assertFalse(ownership.owns("old"))
  }

  @Test
  fun cancelAllSupersedesEveryPendingStart() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("a")
    var answered: String? = null
    ownership.beginPending("a") { answered = it }
    assertTrue(ownership.cancelAll())
    assertFalse(ownership.owns("a"))
    assertFalse(ownership.deliver("a", "started"))
    assertEquals(null, answered)
  }

  @Test
  fun aKeyedCancelOfTheOwnerIsTheOnlyOneThatCancels() {
    val ownership = HandsfreeStartOwnership()
    ownership.claim("a")
    assertTrue(ownership.cancel("a"))
    assertFalse(ownership.owns("a"))
    assertFalse(ownership.cancel("a"))
    assertFalse(ownership.cancel("b"))
  }

  // Concurrency: the module claims on its queue while the service answers on the
  // main thread. One owner must always win, and only it can arm its answer.
  @Test
  fun concurrentClaimsLeaveExactlyOneOwner() {
    val ownership = HandsfreeStartOwnership()
    val threads = (0 until 64).map { index ->
      Thread { ownership.claim("id-$index") }
    }
    threads.forEach { it.start() }
    threads.forEach { it.join() }
    val owners = (0 until 64).filter { ownership.owns("id-$it") }
    assertEquals(1, owners.size)
    val ownerId = "id-${owners.single()}"
    assertTrue(ownership.beginPending(ownerId) { })
  }
}
