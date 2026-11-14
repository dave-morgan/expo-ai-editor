# Inspector indicator controls

The user approved a thin top indicator as the primary control: tap to toggle selection,
tap an app element to select it, hold the enabled indicator to dictate. Release stops
dictation; a hold must never also toggle selection. Holding an inactive indicator does nothing.

The app remains fully interactive while selection is off. While on, only the selection
catcher consumes app taps; selecting an element keeps selection enabled and shows a
pointer-events-free outline, without opening the panel or dimming the app. The old FAB,
selection banner, and scrim are removed. The indicator remains reachable above the catcher.

A centered 96-by-4-point line sits below the status bar, in a 112-by-44-point touch target.
Its narrow target avoids covering the app's corner navigation controls. Hosts can override
the top inset. Gray means off, violet means selection enabled, cyan pulses while starting
or listening, amber means disconnected, red means an error. Accessibility exposes text
state and actions; reduced motion uses a steady recording color.

Pull down from the line to open the existing bottom panel for pairing, thread selection,
typing, transcript review, send, settings, and history. Closing the panel preserves selection
mode. Release finishes dictation; the final transcript opens review unless the existing
auto-submit setting was explicitly enabled. Errors open the panel with readable guidance.
Selection, transcript, and request history survive switching selection off and back on.

Gesture movement cancels a pending hold. Cancellation, backgrounding, disabling selection,
or unmounting must not leave the microphone running. Pending permissions cannot start a
recording after release. Late hit-test responses must not re-enable selection or reopen UI.

Verification covers reducer behavior, real responder callbacks in a rendered indicator,
timer cleanup, accessible alternatives, and the speech permission race. Build, typecheck,
tests, and lint run before completion. Physical-device touch placement and recording still
need device validation; no publishing is required for this UI iteration.
