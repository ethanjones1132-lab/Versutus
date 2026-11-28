import { Href, Link } from 'expo-router';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';
import { type ComponentProps } from 'react';

type Props = Omit<ComponentProps<typeof Link>, 'href'> & { href: Href & string };

export function ExternalLink({ href, onPress, ...rest }: Props) {
  return (
    <Link
      target="_blank"
      {...rest}
      href={href}
      onPress={async (event) => {
        // The caller's handler runs first and is never dropped: the spread
        // above used to carry it in and this prop silently replaced it.
        onPress?.(event);
        if (process.env.EXPO_OS !== 'web') {
          // Prevent the default behavior of linking to the default browser on native.
          event.preventDefault();
          try {
            // Open the link in an in-app browser.
            await openBrowserAsync(href, {
              presentationStyle: WebBrowserPresentationStyle.AUTOMATIC,
            });
          } catch {
            // The OS refused the in-app browser. Nothing here can surface a
            // message, and the tap must not reject unhandled either.
          }
        }
      }}
    />
  );
}
