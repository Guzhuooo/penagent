#!/bin/perl
# Inject touch events into the pen's touchscreen (raw panel coordinates).
# Usage:
#   perl pentap.pl tap X Y [holdMs]
#   perl pentap.pl swipe X1 Y1 X2 Y2 [durationMs]
# Raw ranges on Y02: X 0..279, Y 0..935 (panel is rotated 270 vs. logical 936x280).
use strict;
use warnings;

my $dev = $ENV{PEN_TP} || '/dev/input/event4';
open(my $fh, '+<:raw', $dev) or die "open $dev: $!\n";

sub ev {
    my ($type, $code, $value) = @_;
    my $buf = pack('qqSSl', time(), 0, $type, $code, $value);
    syswrite($fh, $buf) == length($buf) or die "write: $!\n";
}
sub syn    { ev(0, 0, 0) }
sub msleep { select(undef, undef, undef, $_[0] / 1000) }

sub down {
    my ($x, $y) = @_;
    ev(3, 47, 0);      # ABS_MT_SLOT
    ev(3, 57, 1);      # ABS_MT_TRACKING_ID
    ev(3, 53, $x);     # ABS_MT_POSITION_X
    ev(3, 54, $y);     # ABS_MT_POSITION_Y
    ev(3, 48, 30);     # ABS_MT_TOUCH_MAJOR
    ev(3, 58, 60);     # ABS_MT_PRESSURE
    ev(1, 330, 1);     # BTN_TOUCH
    syn();
}
sub move {
    my ($x, $y) = @_;
    ev(3, 53, $x);
    ev(3, 54, $y);
    syn();
}
sub up {
    ev(3, 57, -1);
    ev(1, 330, 0);
    syn();
}

my $cmd = shift @ARGV // '';
if ($cmd eq 'tap') {
    my ($x, $y, $hold) = @ARGV;
    die "tap X Y [holdMs]\n" unless defined $y;
    down($x, $y);
    msleep($hold // 60);
    up();
} elsif ($cmd eq 'swipe') {
    my ($x1, $y1, $x2, $y2, $dur) = @ARGV;
    die "swipe X1 Y1 X2 Y2 [durationMs]\n" unless defined $y2;
    $dur //= 300;
    my $steps = 12;
    down($x1, $y1);
    for my $i (1 .. $steps) {
        msleep($dur / $steps);
        move(int($x1 + ($x2 - $x1) * $i / $steps), int($y1 + ($y2 - $y1) * $i / $steps));
    }
    up();
} else {
    die "usage: tap X Y [holdMs] | swipe X1 Y1 X2 Y2 [durationMs]\n";
}
close($fh);
print "ok\n";
