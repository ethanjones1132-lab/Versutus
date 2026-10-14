/** Keep Node's test worker alive while an unref'd production deadline settles. */
export function keepEventLoopAlive(t) {
  const handle = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(handle));
}
