{pkgs}: {
  deps = [
    pkgs.eudev
    pkgs.expat
    pkgs.libdrm
    pkgs.mesa
    pkgs.libxkbcommon
    pkgs.alsa-lib
    pkgs.cairo
    pkgs.pango
    pkgs.cups
    pkgs.xorg.libXi
    pkgs.xorg.libXtst
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libxcb
    pkgs.xorg.libX11
    pkgs.at-spi2-atk
    pkgs.atk
    pkgs.dbus
    pkgs.nspr
    pkgs.nss
    pkgs.glib
  ];
}
