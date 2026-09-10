# 🫧 Gushu

### A modern, cross-platform communication experience built for speed, simplicity, and a polished user experience.

<p align="center">
  <a href="https://gushu-nine.vercel.app">
    <img src="https://img.shields.io/badge/Live%20Demo-Gushu-7C3AED?style=for-the-badge&logo=vercel&logoColor=white" alt="Live Demo">
  </a>
  <a href="https://github.com/himanshuxjs-coder/Gushu">
    <img src="https://img.shields.io/badge/GitHub-Repository-18181B?style=for-the-badge&logo=github&logoColor=white" alt="GitHub">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img src="https://img.shields.io/badge/React-18+-61DAFB?style=flat-square&logo=react&logoColor=black">
  <img src="https://img.shields.io/badge/Vite-Powered-646CFF?style=flat-square&logo=vite&logoColor=white">
  <img src="https://img.shields.io/badge/Supabase-Backend-3ECF8E?style=flat-square&logo=supabase&logoColor=white">
  <img src="https://img.shields.io/badge/Capacitor-Android-119EFF?style=flat-square&logo=capacitor&logoColor=white">
</p>

---

## ✨ What is Gushu?

**Gushu** is a modern communication application focused on delivering a clean, responsive, and platform-friendly messaging experience.

The project combines a modern web stack with native Android capabilities, allowing the same application ecosystem to serve both web and mobile users.

Instead of building a basic CRUD interface and calling it a messaging app, Gushu is structured around the pieces required for a more complete product:

* 💬 Real-time communication
* 🔐 Authentication & user management
* 🔔 Push notifications
* 📱 Android support
* ☁️ Cloud-backed data
* ⚡ Fast Vite development workflow
* 🎨 Component-driven UI
* 📦 Production-ready build tooling

---

## 🚀 Live Demo

### Try Gushu

**[Launch the Web App →](https://gushu-nine.vercel.app)**

> The live deployment is hosted on Vercel.

---

## 🎯 Core Features

### 💬 Messaging

Built around a dedicated messaging experience where conversations and messages can be managed through the application's backend.

### 🔐 Authentication

User authentication is integrated into the application architecture, providing the foundation for account-based experiences.

### 🔔 Push Notifications

Gushu includes native push-notification support through Capacitor and Firebase integration.

This allows the application to move beyond browser-only notifications and support a more native mobile experience.

### 📱 Android

The project contains an Android application layer powered by **Capacitor**, allowing the web application to be packaged and operated as a native Android application.

### ☁️ Supabase Backend

Supabase is used as part of the backend architecture for cloud-backed application functionality.

This gives Gushu a clean separation between:

```text
┌──────────────────────┐
│      Gushu UI        │
│   React + TypeScript │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│     Supabase         │
│ Auth / Data / APIs   │
└──────────────────────┘
```

### 🎨 Modern UI Components

The project uses a component-based UI architecture together with Radix UI primitives, making it easier to build consistent and accessible interface elements.

---

# 🧰 Tech Stack

| Layer              | Technology           |
| ------------------ | -------------------- |
| Language           | TypeScript           |
| Frontend           | React                |
| Build Tool         | Vite                 |
| UI Primitives      | Radix UI             |
| Backend Services   | Supabase             |
| Mobile Runtime     | Capacitor            |
| Android            | Capacitor Android    |
| Push Notifications | Firebase + Capacitor |
| Deployment         | Vercel               |
| Formatting         | Prettier             |
| Linting            | ESLint               |

The repository's package configuration confirms Vite-based development/build scripts and dependencies for Capacitor, Supabase-related functionality, Firebase/notification infrastructure, React UI primitives, and other supporting packages.

---

# 🏗️ Architecture

At a high level, Gushu follows a layered application structure:

```text
                         ┌─────────────────┐
                         │     Gushu       │
                         │    Frontend     │
                         └────────┬────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
             Web Application              Android App
                    │                           │
              Vite + React                 Capacitor
                    │                           │
                    └─────────────┬─────────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │    Supabase     │
                         │ Backend / Data  │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │    Firebase     │
                         │ Push Services   │
                         └─────────────────┘
```

The repository is organized around `src`, `android`, and `supabase` directories, with additional configuration for Capacitor, Vite, TypeScript, ESLint, Prettier, and Firebase push setup.

---

# 📂 Project Structure

```text
Gushu/
│
├── 📁 android/              # Native Android project
│
├── 📁 src/                  # Main application source
│
├── 📁 supabase/             # Supabase configuration/functions
│
├── 📁 .lovable/             # Lovable project configuration
│
├── 📄 capacitor.config.ts   # Capacitor configuration
├── 📄 vite.config.ts        # Vite configuration
├── 📄 tsconfig.json         # TypeScript configuration
├── 📄 eslint.config.js      # ESLint configuration
├── 📄 .prettierrc           # Prettier configuration
│
├── 📄 FIREBASE_PUSH_SETUP_GUIDE.md
├── 📄 VERIFICATION_REPORT.md
│
├── 📄 package.json
├── 📄 bun.lock
└── 📄 README.md
```

---

# ⚡ Getting Started

## 1. Clone the repository

```bash
git clone https://github.com/himanshuxjs-coder/Gushu.git

cd Gushu
```

## 2. Install dependencies

Using Bun:

```bash
bun install
```

Or using npm:

```bash
npm install
```

## 3. Configure environment variables

Create your local environment file:

```bash
cp .env.example .env
```

Then configure the required backend and notification credentials.

> Never commit real API keys, service-role keys, private Firebase credentials, or other secrets to Git.

---

# 🧑‍💻 Development

Start the development server:

```bash
bun run dev
```

Or:

```bash
npm run dev
```

Vite will start the local development environment.

---

# 🏭 Production Build

Create a production build:

```bash
bun run build
```

For a development-mode build:

```bash
bun run build:dev
```

Preview the production build locally:

```bash
bun run preview
```

These commands are defined in the project's package configuration.

---

# 📱 Android Development

Gushu includes a native Android layer through Capacitor.

After building the web application, synchronize the native project:

```bash
npx cap sync android
```

Then open the Android project:

```bash
npx cap open android
```

From there, Android Studio can be used to build and run the application on an emulator or connected device.

---

# 🔔 Push Notifications

Push notification infrastructure is included in the project through:

* Firebase
* Capacitor Push Notifications
* Native Android integration

A dedicated setup guide is included in the repository:

```text
FIREBASE_PUSH_SETUP_GUIDE.md
```

Follow that guide when configuring Firebase credentials and notification services.

---

# 🧹 Code Quality

Run ESLint:

```bash
bun run lint
```

Format the project:

```bash
bun run format
```

Keeping formatting and linting consistent makes the codebase easier to maintain and contribute to.

---

# 🔐 Security

Gushu uses external services that require credentials.

**Do not commit secrets.**

Keep sensitive values inside environment variables:

```env
VITE_SUPABASE_URL=your_url
VITE_SUPABASE_ANON_KEY=your_key
```

Never place private service credentials directly inside frontend source code.

### ⚠️ Important

If credentials have already been committed to Git history, simply deleting the file is **not enough**.

Rotate the exposed credentials and remove the sensitive data from the repository history if necessary.

---

# 🛣️ Roadmap

Gushu is designed to evolve into a more complete communication platform.

Potential areas for future development:

* [ ] Advanced message reactions
* [ ] Typing indicators
* [ ] Online/offline presence
* [ ] Message search
* [ ] Media sharing
* [ ] Voice messages
* [ ] Improved notification controls
* [ ] Message delivery/read states
* [ ] Group conversations
* [ ] Profile customization
* [ ] Enhanced Android experience
* [ ] Automated testing
* [ ] CI/CD pipeline

---

# 🤝 Contributing

Contributions are welcome.

### Fork

Create your own fork of the repository.

### Clone

```bash
git clone https://github.com/YOUR_USERNAME/Gushu.git
```

### Create a branch

```bash
git checkout -b feature/my-feature
```

### Make your changes

Keep changes focused and maintain the existing project conventions.

### Commit

```bash
git commit -m "feat: add my feature"
```

### Push

```bash
git push origin feature/my-feature
```

Then open a Pull Request.

---

# 📜 License

Add the project's license here once a license has been selected.

> If you intend Gushu to be genuinely open source, don't leave this ambiguous. Pick a license such as MIT, Apache-2.0, or another license that matches your goals.

---

# 👨‍💻 Author

### Himanshu

Built with curiosity, TypeScript, and a questionable number of development sessions. ☕💻

**GitHub:**
https://github.com/himanshuxjs-coder

---

<div align="center">

### ⭐ If Gushu is useful or interesting, consider giving it a star.

**Build. Ship. Improve.**

</div>
