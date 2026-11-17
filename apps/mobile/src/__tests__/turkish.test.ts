import { dativeTr } from '@/utils/turkish';

describe('dativeTr', () => {
  it('follows the last vowel of the name', () => {
    expect(dativeTr('Can')).toBe("Can'a");
    expect(dativeTr('Gül')).toBe("Gül'e");
    expect(dativeTr('Mehmet')).toBe("Mehmet'e");
    expect(dativeTr('Oğuz')).toBe("Oğuz'a");
    expect(dativeTr('Ali Can')).toBe("Ali Can'a");
  });

  it('puts a "y" between a final vowel and the suffix', () => {
    expect(dativeTr('Ali')).toBe("Ali'ye");
    expect(dativeTr('Mustafa')).toBe("Mustafa'ya");
    expect(dativeTr('Emre')).toBe("Emre'ye");
    expect(dativeTr('Ayşegül ')).toBe("Ayşegül'e");
    // an initial that is a vowel is read as itself: "E'ye"
    expect(dativeTr('Ali E')).toBe("Ali E'ye");
  });

  it('fronts the suffix after the soft "l" of Kemal and Hilal', () => {
    expect(dativeTr('Kemal')).toBe("Kemal'e");
    expect(dativeTr('Mustafa Kemal')).toBe("Mustafa Kemal'e");
    expect(dativeTr('Celâl')).toBe("Celâl'e");
    expect(dativeTr('HİLAL')).toBe("HİLAL'e");
    // a Turkish "l" stays back
    expect(dativeTr('Vural')).toBe("Vural'a");
  });

  it('reads capitals the Turkish way', () => {
    expect(dativeTr('EMRE')).toBe("EMRE'ye");
    expect(dativeTr('İLKER')).toBe("İLKER'e");
    expect(dativeTr('IRMAK')).toBe("IRMAK'a");
  });

  it('gives up where no suffix is right, so the caller can phrase around it', () => {
    expect(dativeTr('🔥')).toBeNull();
    expect(dativeTr('Ali 🔥')).toBeNull();
    expect(dativeTr('Ali2')).toBeNull();
    expect(dativeTr('MSN')).toBeNull();
    expect(dativeTr('')).toBeNull();
    // an initial or an acronym is read letter by letter ("Y'ye", "CK'ya"), so
    // the first name's vowel must not pick its suffix ("Ahmet Y'e", "Can CK'a")
    expect(dativeTr('Ahmet Y')).toBeNull();
    expect(dativeTr('Mehmet K')).toBeNull();
    expect(dativeTr('Can CK')).toBeNull();
    expect(dativeTr('Burak TR')).toBeNull();
    expect(dativeTr('Emre MSN')).toBeNull();
  });
});
