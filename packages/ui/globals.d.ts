declare module '*.css' {
  const styles: { [className: string]: string };
  export default styles;
}

interface Window {
  Context: {
    secretRoute: string;
    contest: {
      id: string;
      name: string;
    };
  };
}
