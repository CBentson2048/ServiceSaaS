import { Alert } from 'react-native';

export interface ConfirmDestructiveOptions {
  /** Short, specific: "Archive Majirel 7.1?" not "Are you sure?". */
  title: string;
  /** What will happen, and what cannot be undone. */
  message: string;
  /** The verb, not "OK": "Archive", "Reset", "Discard". */
  confirmLabel: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
}

/**
 * ASK BEFORE DOING SOMETHING IRREVERSIBLE.
 *
 * This app had no confirmation mechanism at all — `Alert` was not imported
 * anywhere in `src/`. Three server-side destructive actions fired on a single
 * tap, two of them from a small ghost button sitting next to Save:
 *
 *   - Archive product — removes it from every picker at every station.
 *   - Reset billing rules — replaces every service's pricing configuration with
 *     defaults, discarding the operator's in-progress edits too.
 *   - Reopen draft — throws away every gram captured since the last manual save
 *     (and nothing here saves automatically, despite copy that said so).
 *
 * Resolves `true` only if the operator picked the destructive option, so a
 * caller reads as a plain guard:
 *
 * ```ts
 * if (!(await confirmDestructive({ … }))) return;
 * ```
 *
 * `Alert` rather than a custom sheet on purpose: it is the platform's own
 * modal, it cannot be missed behind another surface (the mistake the Inventory
 * modals made with their error banner), and it needs no layout of its own on a
 * wall-mounted tablet.
 */
export function confirmDestructive({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
}: ConfirmDestructiveOptions): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
      ],
      // Dismissing by tapping outside is a cancel, not a confirm.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
