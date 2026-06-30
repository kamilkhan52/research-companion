// Ambient declarations so TS accepts CSS imports.
// Metro applies these on web; on native they are no-ops.
declare module '*.css';

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
