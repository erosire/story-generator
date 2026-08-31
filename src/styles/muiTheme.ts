// Material UI theme — maps the dashboard's flat-design tokens (styles/theme.ts)
// onto an MUI theme so every Material component (buttons, text fields, dialogs,
// toggles) renders in the dashboard's dark flat language instead of MUI's
// default light look.
//
// Used by the ThemeProvider in App.tsx. The modular components in src/components
// apply their exact flat frames via sx/style overrides, so they render correctly
// even WITHOUT this provider (component-level tests render bare) — the theme
// exists so MUI's own internal styling (focus rings, disabled states, the
// dialog paper, scroll lock chrome) agrees with the tokens too.

import { createTheme } from '@mui/material/styles';
import { theme } from './theme';

export const muiTheme = createTheme({
    palette: {
        // Dark mode drives MUI's internal color scheme (paper/text elevations).
        mode: 'dark',
        // Brand accent — the indigo used by the primary action + focus rings.
        primary: { main: theme.accent },
        // Semantic tokens from the flat palette.
        error: { main: theme.danger },
        warning: { main: theme.warning },
        success: { main: theme.success },
        // Surfaces + text mirror theme.ts so MUI chrome matches the dashboard.
        background: { default: theme.bg, paper: theme.surfaceDialog },
        text: {
            primary: theme.text,
            secondary: theme.textMuted,
            disabled: theme.textFaint
        },
        // Hairline dividers (dialog bands) use the flat border token.
        divider: theme.border,
        action: {
            hover: theme.surface2,
            selected: theme.accentSoft,
            focus: theme.accentSoft,
            disabled: theme.textFaint,
            disabledBackground: theme.surface1
        }
    },
    // FLAT DESIGN: near-square corners everywhere MUI draws its own radii
    // (text field outlines, chips, dialog paper).
    shape: { borderRadius: theme.radiusSm },
    typography: {
        fontFamily: theme.fontSans,
        // MUI's default button typography uppercases labels — the flat design
        // keeps sentence case. Font sizes inherit the dashboard's rem scale.
        button: {
            textTransform: 'none',
            fontWeight: 600,
            lineHeight: 1.5
        }
    },
    components: {
        // Ripples/glow are the anti-flat texture — disable them globally so
        // every MUI interactive surface keeps the solid color-swap feedback
        // driven by the .sg-* class hooks (styles/global.ts).
        MuiButtonBase: {
            defaultProps: { disableRipple: true }
        },
        MuiButton: {
            defaultProps: { disableElevation: true },
            styleOverrides: {
                root: {
                    boxShadow: 'none'
                }
            }
        },
        // Dialog chrome — the paper is the standard-pattern frame; the bands
        // (title/content/actions) are styled per-instance in components/Dialog.tsx.
        MuiDialog: {
            defaultProps: {
                // Instant transitions: the flat design keeps motion minimal,
                // and zero-duration transitions never depend on jsdom timers.
                transitionDuration: 0
            }
        },
        MuiPaper: {
            styleOverrides: {
                root: {
                    backgroundImage: 'none'
                }
            }
        }
    }
});
