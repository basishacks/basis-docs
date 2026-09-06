import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    title: "basis-auth",
    description: "The authentication and identity boundary for Basis applications.",
    base: "/",
    cleanUrls: true,
    vite: {
      build: {
        target: "es2022",
      },
      optimizeDeps: {
        esbuildOptions: {
          target: "es2022",
        },
      },
    },
    mermaid: {},
    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Guide", link: "/architecture" },
        { text: "Portal", link: "/portal" },
        { text: "Reference", link: "/reference" },
        { text: "FAQ", link: "/devconnect/FAQ" },
      ],
      sidebar: [
        {
          text: "Guide",
          items: [
            { text: "Architecture", link: "/architecture" },
            { text: "Getting Started", link: "/getting-started" },
            { text: "Wiring Up Apps", link: "/wiring-up" },
            { text: "Database Setup", link: "/database" },
          ],
        },
        {
          text: "Management Portal",
          items: [
            { text: "Overview", link: "/portal" },
            { text: "Security Model", link: "/security" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Endpoints", link: "/reference" },
            { text: "DevConnect FAQ", link: "/devconnect/FAQ" },
          ],
        },
      ],
      socialLinks: [
        { icon: "github", link: "https://github.com/basishacks/basis-auth" },
      ],
    },
  }),
);
