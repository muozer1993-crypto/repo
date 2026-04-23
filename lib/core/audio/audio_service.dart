import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';

/// Minimal wrapper around [AudioPlayer] for SFX and instruction playback.
///
/// We use separate players for the short correct-placement SFX and the
/// longer instruction clips so an in-flight instruction does not cut
/// off when the patient taps a correct item.
///
/// Missing-asset failures are swallowed — instruction audio is not
/// yet recorded in v1, and we do not want the app to crash on a
/// missing WAV file. Production builds should have all audio files
/// bundled.
class AudioService {
  AudioService()
      : _sfxPlayer = AudioPlayer(),
        _voicePlayer = AudioPlayer();

  final AudioPlayer _sfxPlayer;
  final AudioPlayer _voicePlayer;

  /// Plays the short correct-placement SFX. Re-uses the player so
  /// rapid successful taps do not queue up behind each other.
  Future<void> playCorrectSoft() => _playAsset(
        _sfxPlayer,
        'assets/audio/correct_soft.wav',
      );

  Future<void> playCelebrate() => _playAsset(
        _sfxPlayer,
        'assets/audio/celebrate.wav',
      );

  /// Plays the scene instruction. Interrupts any in-flight instruction
  /// so the speaker button can be tapped repeatedly.
  Future<void> playInstruction(String assetPath) =>
      _playAsset(_voicePlayer, assetPath);

  /// Plays the short Turkish label for an item. Shared player with
  /// instruction so they cannot overlap.
  Future<void> playItemLabel(String assetPath) =>
      _playAsset(_voicePlayer, assetPath);

  Future<void> dispose() async {
    await _sfxPlayer.dispose();
    await _voicePlayer.dispose();
  }

  Future<void> _playAsset(AudioPlayer player, String assetPath) async {
    try {
      await player.setAsset(assetPath);
      await player.seek(Duration.zero);
      unawaited(player.play());
    } catch (e) {
      // Asset missing in dev / placeholder state. Silent fail.
      debugPrint('audio asset missing: $assetPath ($e)');
    }
  }
}

final audioServiceProvider = Provider<AudioService>((ref) {
  final svc = AudioService();
  ref.onDispose(svc.dispose);
  return svc;
});
