import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Setu",
    short_name: "Setu",
    description: "A voice companion for understanding government documents.",
    start_url: "/",
    display: "standalone",
    background_color: "#faf8f5",
    theme_color: "#ff6b00",
    orientation: "portrait",
    icons: [
      {
        src: "/logo.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
