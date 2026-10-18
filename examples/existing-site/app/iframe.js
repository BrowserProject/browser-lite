// Passes the query of this page (for example ?url=) on to the browser page in the frame
document.querySelector('iframe.browser-frame').src = `frame.html${location.search}`;
