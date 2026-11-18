export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface Tongue {
  id: string;
  /** Название ноты с октавой, например "E2". */
  note: string;
  freq: number;
  center: boolean;
  /** Градусы по часовой стрелке от дальней от игрока точки (180 — ближе всего к игроку). */
  angle: number;
  /**
   * Измеренный спектр поля: пары [номер гармоники, относительная амплитуда].
   * Нужен распознавателю до калибровки; если не задан — берётся общая модель.
   */
  partials?: [number, number][];
  /**
   * Другие «лица» того же поля: спектр зависит от силы и места удара (тихий удар по E2
   * звучит почти одной шестой гармоникой). Распознаватель берёт лучшее совпадение.
   */
  altPartials?: [number, number][][];
}

export interface Scale {
  id: string;
  name: string;
  tongues: Tongue[];
}

/** Громкость удара в упражнениях на динамику. */
export type Dynamic = 'soft' | 'loud';

export interface CompositionNote {
  tongue: string;
  /** Начало ноты в долях от начала композиции. */
  beat: number;
  /** Длительность в долях. */
  duration: number;
  /** Громкость удара; не задана — как удобно. В счёт игры не входит. */
  dyn?: Dynamic;
}

export interface Composition {
  id: string;
  title: string;
  scale: string;
  bpm: number;
  /** Сложность: 1 — простая, 3 — сложная. Необязательное поле. */
  level?: 1 | 2 | 3;
  notes: CompositionNote[];
}

export interface TimedNote {
  tongue: string;
  /** Секунды от начала композиции. */
  time: number;
  duration: number;
  dyn?: Dynamic;
}
