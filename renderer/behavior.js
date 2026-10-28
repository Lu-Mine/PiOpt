/*
 * Behavior view: a rail row with no controls yet.
 *
 * The shell boots each view once, on first reveal, so this file exists to answer
 * that hook instead of letting the row report a missing script. Nothing is drawn
 * on purpose — the empty section is the placeholder, not a broken page.
 */
(function () {
  "use strict";

  function boot() {
    /* no controls yet */
  }

  window.PiOptBehavior = { boot };
})();
