# Device preset audit (2026-09-27)

The preview is a **full-screen CSS layout canvas**: `width × height` is logical pixels, not physical panel pixels. Physical panel resolution divided by DPR gives the full-screen logical size. Real Safari/Chrome viewport height can be smaller because browser chrome changes with scrolling. The sandbox does not emulate a device notch or `env(safe-area-inset-*)`; unsupported fixed inset guesses were removed.

| Preset | CSS canvas · DPR | Evidence and disposition |
| --- | --- | --- |
| iPhone SE (3rd generation) | 375×667 · 2 | Matches maintained Playwright `iPhone SE (3rd gen)` descriptor; unchanged size. |
| iPhone 13 mini | 360×780 · 3 | [Apple 2340×1080 physical display](https://support.apple.com/en-gb/111873) ÷ 3; unchanged size. |
| iPhone 13 / 13 Pro | 390×844 · 3 | Matches maintained Playwright `iPhone 13` screen descriptor; unchanged size. |
| iPhone 13 Pro Max | 428×926 · 3 | Matches maintained Playwright `iPhone 13 Pro Max` screen descriptor; unchanged size. |
| iPhone 15 | 393×852 · 3 | Matches maintained Playwright `iPhone 15` screen descriptor; unchanged size. |
| iPhone 15 Pro Max | 430×932 · 3 | [Apple 2796×1290 physical display](https://support.apple.com/en-ie/111828) ÷ 3 and maintained Playwright descriptor; unchanged size. |
| iPhone 16 Pro | 402×874 · 3 | Matches maintained Playwright `iPhone 16 Pro` screen descriptor; unchanged size. |
| iPhone 16 Pro Max | 440×956 · 3 | Matches maintained Playwright `iPhone 16 Pro Max` screen descriptor; unchanged size. |
| iPad mini (A17 Pro) | 744×1133 · 2 | [Apple 1488×2266 physical display](https://support.apple.com/id-id/121456) ÷ 2. Renamed from ambiguous “6th generation / A17 Pro”. |
| iPad Air 11-inch (M3) | 820×1180 · 2 | [Apple 1640×2360 physical display](https://support.apple.com/en-au/122241) ÷ 2. Generation added to name. |
| iPad Air 13-inch (M3) | 1024×1366 · 2 | [Apple 2048×2732 physical display](https://support.apple.com/en-za/122242) ÷ 2. Generation added to name. |
| iPad Pro 11-inch (M4) | 834×1210 · 2 | [Apple 1668×2420 physical display](https://support.apple.com/pl-pl/119892) ÷ 2. Generation added to name. |
| iPad Pro 13-inch (M4) | 1032×1376 · 2 | [Apple 2064×2752 physical display](https://support.apple.com/en-au/119891) ÷ 2. Generation added to name. |
| Small laptop | 1366×768 · 1 | Generic layout probe, not a specific manufacturer model. Unchanged. |
| 13-inch Retina laptop layout | 1280×832 · 2 | [Apple MacBook Air 13-inch native 2560×1664](https://support.apple.com/en-gb/122209) ÷ 2. Renamed as layout because OS display scaling and browser viewport are configurable. |
| 14-inch Retina laptop layout | 1512×982 · 2 | [Apple MacBook Pro 14-inch native 3024×1964](https://support.apple.com/en-gb/121552) ÷ 2. Renamed as layout for the same reason. |
| 16-inch Retina laptop layout | 1728×1117 · 2 | [Apple MacBook Pro 16-inch native 3456×2234](https://support.apple.com/en-la/121554) ÷ 2. Renamed as layout for the same reason. |
| Retina laptop layout | 1440×900 · 2 | Generic layout probe; no exact hardware identity claimed. Renamed from “MacBook-style laptop”. |

Playwright descriptors above were read from installed `playwright` device descriptors at audit time. They distinguish `screen` from the smaller `viewport` reported with mobile browser chrome. The preview uses the full-screen CSS canvas and labels that choice; it does not claim to emulate browser chrome. Android and responsive breakpoint presets were outside this named iPhone/iPad/laptop audit and left unchanged.
