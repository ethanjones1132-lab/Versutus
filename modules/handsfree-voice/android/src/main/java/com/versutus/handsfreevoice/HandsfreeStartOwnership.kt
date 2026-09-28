package com.versutus.handsfreevoice

/**
 * Who owns the current native call start, and the one answer still owed to the
 * module. A start is claimed by a JS-generated id before any permission work;
 * a later start (or the user's End) takes the id on, so an answer an abandoned
 * attempt is still waiting for cannot open a microphone behind the newer
 * attempt's back.
 *
 * Two threads meet here: the service's callbacks run on the main thread, and
 * the module's async functions run on the module queue (the ownership ones on
 * the main queue, but the record cannot assume that). The pair (owner,
 * pending answer) therefore has to move under one lock. The previous design
 * used a `@Volatile` counter bumped with `+=` and a check-then-clear on the
 * callback, which is exactly the race that let a stale answer clear — or a
 * stale cancel end — a newer attempt. Every read and write here is one
 * critical section, and the callback is invoked only after the lock is
 * released, so answering a start can never re-enter this lock.
 *
 * Deliberately free of Android framework calls: the ownership rules are the
 * part worth a JVM unit test.
 */
internal class HandsfreeStartOwnership {
  private val lock = Any()

  private var owner: String? = null
  private var pendingOwner: String? = null
  private var pendingCallback: ((String) -> Unit)? = null

  /**
   * The id the running [HandsfreeCallService] actually booted for. It lags
   * [owner] while a permission dialog is still up, and it moves to the newer
   * id the moment a newer start's service comes up. A keyed teardown a module
   * cleanup queued is only allowed to end the service while this still names
   * its attempt, so a cleanup whose effect executes after a newer retry has
   * taken the service cannot end the newer call.
   */
  private var serviceOwner: String? = null

  /**
   * Claims [id] as the newest start, superseding every earlier one. Returns
   * true when [id] was not already the owner — a re-claim of the same id is a
   * no-op that must not clear its own pending answer.
   */
  fun claim(id: String): Boolean = synchronized(lock) {
    if (owner == id) return@synchronized false
    owner = id
    pendingOwner = null
    pendingCallback = null
    true
  }

  /** True while [id] is the newest start and has not been cancelled or ended. */
  fun owns(id: String): Boolean = synchronized(lock) { id == owner }

  /**
   * Records the callback the service must answer for [id]. Returns false when
   * [id] no longer owns the start, so the caller can settle it as unavailable
   * without arming a callback that belongs to a superseded attempt.
   */
  fun beginPending(id: String, callback: (String) -> Unit): Boolean = synchronized(lock) {
    if (id != owner) return@synchronized false
    pendingOwner = id
    pendingCallback = callback
    true
  }

  /**
   * Answers [id]'s pending start exactly once. False when [id] no longer owns
   * the pending answer — a newer attempt claimed the start, or this id was
   * already answered or cancelled — so a stale service start cannot resolve
   * (or clear) the callback a newer attempt depends on.
   */
  fun deliver(id: String, outcome: String): Boolean {
    val callback = synchronized(lock) {
      if (id != pendingOwner) return false
      val armed = pendingCallback
      pendingOwner = null
      pendingCallback = null
      armed
    }
    callback?.invoke(outcome)
    return callback != null
  }

  /**
   * Gives up on [id] because its module timer ran out. This is not a bare
   * pending release: the id's OWNERSHIP is invalidated too. A stale
   * `ACTION_START` the service has not processed yet would otherwise still
   * pass [owns] and open a microphone for a start the module already reported
   * as unavailable. A newer retry's claim moved [owner] on, so [expire] for the
   * old id reports false and never touches the newer attempt.
   */
  fun expire(id: String): Boolean = synchronized(lock) {
    if (id != owner) return@synchronized false
    owner = null
    if (pendingOwner == id) {
      pendingOwner = null
      pendingCallback = null
    }
    true
  }

  /**
   * Cancels exactly [id] if it is the current owner. A cleanup whose id has
   * already been superseded cancels nothing, so an old cancel can never
   * invalidate a newer attempt. Returns true only when this id was the owner.
   */
  fun cancel(id: String): Boolean = synchronized(lock) {
    if (id != owner) return@synchronized false
    owner = null
    pendingOwner = null
    pendingCallback = null
    true
  }

  /**
   * Supersedes every start the module is still waiting on. This is the user's
   * End, which owns the whole native side rather than one attempt. Returns true
   * when there was an owner to clear.
   */
  fun cancelAll(): Boolean = synchronized(lock) {
    val had = owner != null
    owner = null
    pendingOwner = null
    pendingCallback = null
    had
  }

  /**
   * Records that the service has actually come up for [id] (a null [id] is the
   * service's own boot with no call). The service's owner follows the attempt
   * each boot was for, which is what a keyed teardown checks at execution.
   */
  fun noteServiceStart(id: String?) = synchronized(lock) {
    serviceOwner = id
  }

  /**
   * True while the service booted for [id] and has not been superseded. A
   * cleanup queued for an old attempt re-checks this the moment its teardown
   * would run: a newer retry's service has already replaced the owner, so the
   * old cleanup cannot end the newer call.
   */
  fun servesService(id: String): Boolean = synchronized(lock) { id == serviceOwner }

  /** The attempt the service booted for, or null when no call has a service. */
  fun currentService(): String? = synchronized(lock) { serviceOwner }

  /** Clears the service owner when the call tears down. */
  fun clearService() = synchronized(lock) {
    serviceOwner = null
  }
}
