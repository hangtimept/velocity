# BarVelocity — Professional Barbell Velocity Tracker

A fully client-side, mobile-optimized **Velocity Based Training (VBT)** web app that runs on GitHub Pages. Track barbell speed, range of motion, and reps using only your phone’s camera and a high-contrast marker.

![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-Web%20%7C%20Mobile-blue)

## Features

- **Real-time camera tracking** of a colored marker on the barbell end (side view)
- **Mean concentric velocity**, peak velocity, ROM (displacement), and estimated power
- **Automatic rep detection** with velocity-loss monitoring
- **Configurable target velocity** and % velocity-loss cutoff (classic VBT auto-regulation)
- **Audio feedback** (beeps on good reps / cutoff)
- **Bar path trail** overlay
- **Set summary** with per-rep breakdown and simple chart
- **Session history** stored locally (no account required)
- **Mobile-first** professional dark UI, PWA-ready, works offline after first load
- Pure HTML/CSS/JS — no backend, no build step

## How it works

1. Attach a bright solid-color marker (neon green or orange recommended, ~4–8 cm diameter) to the end of the barbell sleeve.
2. Place your phone on a tripod so the camera has a clear **side view** of the marker through the full range of motion.
3. Enter marker diameter for scale calibration, load, target velocity, and velocity-loss cutoff.
4. Open the camera, optionally sample the exact marker color by tapping it, then start tracking.
5. Perform your set. The app detects eccentric → concentric phases and reports metrics live.
6. End the set to review summary and optionally save the session.

Scale is derived automatically from the known marker diameter (pixels → meters). Vertical position over time yields velocity.

## Deploy to GitHub Pages

1. Create a new repository (or use an existing one).
2. Upload the contents of this folder (`index.html`, `styles.css`, `app.js`, `manifest.json`, `README.md`) to the root of the repo (or a `/docs` folder).
3. In repo **Settings → Pages**, set the source to the branch and folder you used.
4. Visit `https://<username>.github.io/<repo>/`.

**Important:** Camera access requires HTTPS (GitHub Pages provides this) or `localhost`.

## Usage tips for accuracy

- Use a matte, highly saturated marker that contrasts with the background and your clothing.
- Keep the phone parallel to the plane of motion and far enough that the marker never leaves the frame.
- Good lighting helps color detection; avoid strong backlight.
- If tracking is noisy, increase “Min blob size” or adjust “Color tolerance” in Settings.
- For best results, sample the marker color once the camera is positioned.

## Tech stack

- Vanilla JavaScript (ES6+)
- Canvas 2D for overlay + pixel analysis
- `getUserMedia` for camera
- Web Audio API for beeps
- `localStorage` for history
- CSS custom properties, glassmorphism HUD, responsive layout

No heavy ML models are required — color blob tracking is fast and reliable on mid-range phones when a proper marker is used.

## Limitations

- Accuracy depends on marker contrast, lighting, camera angle, and correct diameter input.
- Lateral (X) motion is recorded but primary metrics use the vertical component.
- Not a laboratory-grade substitute for a linear position transducer; it is a practical training tool.
- Works best on modern mobile browsers (Chrome / Safari / Firefox).

## Future ideas

- Import recorded video for offline analysis
- Load-velocity profile builder across sets
- Export CSV / share summary image
- Optional ArUco / AprilTag support for even more robust scale

## License

MIT — free for personal and commercial use. Attribution appreciated but not required.

---

Built for athletes and coaches who want objective velocity feedback without extra hardware.
