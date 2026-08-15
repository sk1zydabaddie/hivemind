/* Vite serves an imported image as a URL string. Without this the two theme
   variants of the brand mark are untyped imports and the build refuses them. */
declare module "*.png" {
  const src: string;
  export default src;
}
