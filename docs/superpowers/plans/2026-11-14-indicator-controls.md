# Indicator controls implementation plan

**Goal:** Replace the obstructive floating inspector with the approved tap/select/hold line.

**Architecture:** Keep selection enablement separate from panel visibility in the reducer.
Use a focused Indicator component for responder timers, swipe detection, accessibility, and
native-driven pulse animation. Keep hit testing and speech ownership in InspectorRoot.

**Tech stack:** React Native, TypeScript, Animated, Vitest, react-test-renderer.

1. Update reducer behavior tests: selection starts off; choosing an element leaves the
   panel closed; toggle preserves drafts; drawer close preserves mode; disabled late hits
   are ignored. Run the tests to observe failure, then update the reducer and callers.
2. Add indicator responder tests for short tap, enabled hold/release, inactive hold,
   swipe, movement, cancellation, and unmount. Implement the component with a 450ms hold
   and 24-point downward swipe. Keep the line accessible with explicit actions.
3. Replace FAB/banner/catcher long-press wiring in AIInspector. Keep the catcher transparent,
   show highlights only during selection, keep the indicator above the drawer, and open
   review after final voice results. Test the rendered root's interaction behavior.
4. Protect speech start against release during permissions and cleanup on background/unmount.
   Cover the permission race with a hook test using a deferred permission result.
5. Update README/setup instructions. Run package tests, build, whole-repo typecheck, lint,
   and inspect the final diff. Record any device validation limits.
